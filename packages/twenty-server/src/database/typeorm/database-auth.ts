import { DatabaseAuthMode } from 'src/database/typeorm/interfaces/database-auth-mode.interface';

/**
 * Support for managed Postgres services that issue short-lived auth tokens
 * instead of accepting a static password — currently Azure Database for
 * PostgreSQL with Microsoft Entra ID, where password authentication can be
 * disabled outright at the server level.
 *
 * `pg` accepts a function for `password` and invokes it during the auth
 * handshake of every *new* connection, so a long-lived pool stays healthy
 * across token expiry with no reconnect logic. Getting the callback all the way
 * down to `pg` takes some care, though — see `buildDatabaseAuthExtra` below.
 *
 * This is inert unless opted into: with `PG_DATABASE_AUTH_MODE` unset or set to
 * `PASSWORD` (the default), `buildDatabaseAuthExtra` returns an empty object and
 * connection behaviour is byte-for-byte unchanged.
 *
 * Env vars are read directly rather than through `TwentyConfigService` because
 * two of the three call sites (`core.datasource.ts`, `raw.datasource.ts`) are
 * module-level constants evaluated outside the Nest DI container — they are
 * used by the TypeORM CLI and the `setup-db` script.
 */

/** Scope Azure Database for PostgreSQL expects on an Entra ID access token. */
const AZURE_POSTGRES_TOKEN_SCOPE =
  'https://ossrdbms-aad.database.windows.net/.default';

/**
 * Renew a little before expiry so a token cannot lapse in the window between
 * being handed to `pg` and the server validating it.
 */
const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;

/**
 * Upper bound on a single token acquisition. The identity endpoint is
 * link-local and normally answers in milliseconds, so this only ever fires when
 * something is wrong. It matters because the in-flight request is *shared*: an
 * acquisition that never settles would otherwise park every subsequent
 * connection attempt behind it indefinitely, and `pg` applies no connection
 * timeout of its own unless one is configured.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 30 * 1000;

/**
 * Resolved through a `string`-typed identifier rather than a literal so that
 * the server still typechecks and builds when the optional `@azure/identity`
 * dependency is not installed.
 */
const AZURE_IDENTITY_MODULE_ID: string = '@azure/identity';

/**
 * Mirrors the spellings `TwentyConfigService` accepts for a boolean, so a value
 * this module reads straight off `process.env` cannot disagree with what the
 * config surface reports for the same variable.
 */
const isEnvFlagEnabled = (value: string | undefined): boolean =>
  value !== undefined &&
  ['true', 'on', 'yes', '1'].includes(value.trim().toLowerCase());

type AccessToken = {
  token: string;
  expiresOnTimestamp: number;
};

type TokenCredential = {
  getToken: (scope: string) => Promise<AccessToken | null>;
};

let credentialPromise: Promise<TokenCredential> | null = null;
let inFlightToken: Promise<AccessToken> | null = null;
let cachedToken: AccessToken | null = null;

const importAzureIdentity = async () => {
  try {
    return await import(AZURE_IDENTITY_MODULE_ID);
  } catch (error) {
    throw new Error(
      `PG_DATABASE_AUTH_MODE is "${DatabaseAuthMode.AZURE_MANAGED_IDENTITY}" but the optional "@azure/identity" package could not be loaded. Install it to use Entra ID database authentication. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const loadAzureCredential = async (): Promise<TokenCredential> => {
  const { DefaultAzureCredential, ManagedIdentityCredential } =
    await importAzureIdentity();

  const clientId = process.env.PG_DATABASE_AZURE_CLIENT_ID;

  // `DefaultAzureCredential` walks a broad chain that includes environment
  // variables and a developer's local Azure CLI login. That is convenient
  // locally but wrong by default for a database credential: an unrelated
  // AZURE_CLIENT_SECRET in the environment would silently outrank the intended
  // managed identity, and a developer running the server would connect as
  // themselves rather than as the app. Narrow managed identity is the default;
  // the broad chain has to be asked for by name.
  if (
    isEnvFlagEnabled(process.env.PG_DATABASE_AZURE_USE_DEFAULT_CREDENTIAL_CHAIN)
  ) {
    return new DefaultAzureCredential(
      clientId ? { managedIdentityClientId: clientId } : undefined,
    );
  }

  // With no client id this resolves the system-assigned identity.
  return clientId
    ? new ManagedIdentityCredential({ clientId })
    : new ManagedIdentityCredential();
};

const isUsable = (token: AccessToken | null): token is AccessToken =>
  token !== null &&
  token.expiresOnTimestamp - TOKEN_EXPIRY_SKEW_MS > Date.now();

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const fetchAccessToken = async (): Promise<AccessToken> => {
  if (credentialPromise === null) {
    credentialPromise = loadAzureCredential().catch((error) => {
      // Do not memoize a failed load; a transient failure should not
      // permanently poison every later connection attempt.
      credentialPromise = null;
      throw error;
    });
  }

  const credential = await credentialPromise;
  const token = await withTimeout(
    credential.getToken(AZURE_POSTGRES_TOKEN_SCOPE),
    TOKEN_REQUEST_TIMEOUT_MS,
    `Timed out after ${TOKEN_REQUEST_TIMEOUT_MS}ms acquiring a Microsoft Entra ID access token for Postgres.`,
  );

  if (token === null) {
    throw new Error(
      'Failed to acquire a Microsoft Entra ID access token for Postgres: the credential chain returned no token.',
    );
  }

  return token;
};

/**
 * Mint (or reuse) an Entra ID access token to present to Postgres as a
 * password. A token is requested once per *new* pooled connection, so the
 * in-flight promise is shared as well as the resolved token — otherwise a pool
 * ramping up N connections against a cold cache would fire N concurrent
 * requests at a rate-limited identity endpoint.
 */
export const getAzureDatabaseAccessToken = async (): Promise<string> => {
  if (isUsable(cachedToken)) {
    return cachedToken.token;
  }

  if (inFlightToken === null) {
    inFlightToken = fetchAccessToken()
      .then((token) => {
        cachedToken = token;

        return token;
      })
      .finally(() => {
        inFlightToken = null;
      });
  }

  return (await inFlightToken).token;
};

const readSslMode = (url: string | undefined): string | undefined => {
  if (url === undefined || url === '') {
    return undefined;
  }

  try {
    return (
      new URL(url).searchParams.get('sslmode')?.trim().toLowerCase() ??
      undefined
    );
  } catch {
    return undefined;
  }
};

type SslOptions = { rejectUnauthorized: boolean };

const resolveSsl = (url: string | undefined): SslOptions => {
  if (readSslMode(url) === 'disable') {
    throw new Error(
      `PG_DATABASE_AUTH_MODE is "${DatabaseAuthMode.AZURE_MANAGED_IDENTITY}" but the connection URL requests "sslmode=disable". The Entra ID access token is sent to the server in place of a password, so it must not travel in cleartext. Remove "sslmode=disable" from PG_DATABASE_URL.`,
    );
  }

  return {
    rejectUnauthorized: !isEnvFlagEnabled(process.env.PG_SSL_ALLOW_SELF_SIGNED),
  };
};

const resolveAuthMode = (): DatabaseAuthMode => {
  const rawAuthMode = process.env.PG_DATABASE_AUTH_MODE;

  if (rawAuthMode === undefined || rawAuthMode === '') {
    return DatabaseAuthMode.PASSWORD;
  }

  const normalizedAuthMode = rawAuthMode
    .trim()
    .toUpperCase()
    .replace(/-/g, '_');

  if (
    !Object.values(DatabaseAuthMode).includes(
      normalizedAuthMode as DatabaseAuthMode,
    )
  ) {
    throw new Error(
      `Invalid PG_DATABASE_AUTH_MODE "${rawAuthMode}". Expected one of: ${Object.values(
        DatabaseAuthMode,
      ).join(', ')}.`,
    );
  }

  return normalizedAuthMode as DatabaseAuthMode;
};

/**
 * Extra `pg` pool options implementing the configured authentication mode.
 * Spread into a TypeORM data source's `extra`; empty for the default mode.
 *
 * `url` is the connection URL that data source was configured with, needed to
 * honour its `sslmode`. Pass the replica URL for a replica data source.
 *
 * Two of the three keys returned here are load-bearing in a way that is not
 * obvious, and removing either silently breaks the feature:
 *
 *  - `connectionString: undefined` — TypeORM merges `extra` last, so the
 *    callback above does reach its pool config. But `pg` then re-parses
 *    `connectionString` and spreads the *parsed* result over everything else
 *    (`ConnectionParameters`), and `pg-connection-string` emits an own
 *    `password: ''` for a passwordless URL. That silently replaces the callback
 *    with an empty string, which `pg` then treats as absent and falls back to
 *    `PGPASSWORD`. Clearing `connectionString` stops the re-parse; TypeORM has
 *    already lifted host/port/user/database out of the URL by this point.
 *  - `ssl` — the URL's `sslmode` is what enables TLS today, and it is only read
 *    during that same re-parse. Clearing `connectionString` without restoring
 *    `ssl` drops `pg` to its `ssl: false` default and sends the access token
 *    across the wire in cleartext.
 */
export const buildDatabaseAuthExtra = (
  url?: string,
): Record<string, unknown> => {
  if (resolveAuthMode() !== DatabaseAuthMode.AZURE_MANAGED_IDENTITY) {
    return {};
  }

  return {
    password: getAzureDatabaseAccessToken,
    connectionString: undefined,
    ssl: resolveSsl(url),
  };
};
