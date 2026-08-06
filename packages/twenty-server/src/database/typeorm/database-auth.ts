import { DatabaseAuthMode } from 'src/database/typeorm/interfaces/database-auth-mode.interface';

/**
 * Support for managed Postgres services that issue short-lived auth tokens
 * instead of accepting a static password — currently Azure Database for
 * PostgreSQL with Microsoft Entra ID, where password authentication can be
 * disabled outright at the server level.
 *
 * Two properties of the stack make this a small change:
 *
 *  - `pg` accepts a function for `password` and invokes it during the auth
 *    handshake of every *new* connection, so a pool stays healthy across token
 *    expiry without any reconnect logic here.
 *  - TypeORM merges `options.extra` last into the pool config, so `extra`
 *    wins over the credentials it parsed out of `PG_DATABASE_URL`. The URL is
 *    therefore left passwordless (`postgres://<user>@<host>:5432/<db>`).
 *
 * This is inert unless opted into: with `PG_DATABASE_AUTH_MODE` unset or set to
 * `PASSWORD` (the default), `buildDatabaseAuthExtra` returns an empty object and
 * connection behaviour is byte-for-byte unchanged.
 *
 * The env var is read directly rather than through `TwentyConfigService`
 * because two of the three call sites (`core.datasource.ts`, `raw.datasource.ts`)
 * are module-level constants evaluated outside the Nest DI container — they are
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
 * Resolved through a `string`-typed identifier rather than a literal so that
 * the server still typechecks and builds when the optional `@azure/identity`
 * dependency is not installed.
 */
const AZURE_IDENTITY_MODULE_ID: string = '@azure/identity';

type AccessToken = {
  token: string;
  expiresOnTimestamp: number;
};

type TokenCredential = {
  getToken: (scope: string) => Promise<AccessToken | null>;
};

let credentialPromise: Promise<TokenCredential> | null = null;
let cachedToken: AccessToken | null = null;

const loadAzureCredential = async (): Promise<TokenCredential> => {
  try {
    const { DefaultAzureCredential, ManagedIdentityCredential } = await import(
      AZURE_IDENTITY_MODULE_ID
    );

    const clientId = process.env.PG_DATABASE_AZURE_CLIENT_ID;

    // A user-assigned identity has to be named explicitly; without one, defer
    // to the ambient chain (system-assigned identity, workload identity, or a
    // developer's local Azure CLI login).
    return clientId
      ? new ManagedIdentityCredential({ clientId })
      : new DefaultAzureCredential();
  } catch (error) {
    throw new Error(
      `PG_DATABASE_AUTH_MODE is "${DatabaseAuthMode.AZURE_MANAGED_IDENTITY}" but the optional "@azure/identity" package could not be loaded. Install it to use Entra ID database authentication. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const isUsable = (token: AccessToken | null): token is AccessToken =>
  token !== null &&
  token.expiresOnTimestamp - TOKEN_EXPIRY_SKEW_MS > Date.now();

/**
 * Mint (or reuse) an Entra ID access token to present to Postgres as a
 * password. `@azure/identity` caches internally, but a token is requested once
 * per new pooled connection, so the local cache keeps connection storms from
 * turning into a burst of identity-endpoint calls.
 */
export const getAzureDatabaseAccessToken = async (): Promise<string> => {
  if (isUsable(cachedToken)) {
    return cachedToken.token;
  }

  if (credentialPromise === null) {
    credentialPromise = loadAzureCredential().catch((error) => {
      // Do not memoize a failed load; a transient failure should not
      // permanently poison every later connection attempt.
      credentialPromise = null;
      throw error;
    });
  }

  const credential = await credentialPromise;
  const token = await credential.getToken(AZURE_POSTGRES_TOKEN_SCOPE);

  if (token === null) {
    throw new Error(
      'Failed to acquire a Microsoft Entra ID access token for Postgres: the credential chain returned no token.',
    );
  }

  cachedToken = token;

  return token.token;
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
 */
export const buildDatabaseAuthExtra = (): Record<string, unknown> => {
  if (resolveAuthMode() !== DatabaseAuthMode.AZURE_MANAGED_IDENTITY) {
    return {};
  }

  return { password: getAzureDatabaseAccessToken };
};

/** Test seam — resets the module-level credential and token caches. */
export const resetDatabaseAuthCacheForTesting = (): void => {
  credentialPromise = null;
  cachedToken = null;
};
