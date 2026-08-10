import { Client } from 'pg';

import { DatabaseAuthMode } from 'src/database/typeorm/interfaces/database-auth-mode.interface';

const AZURE_URL =
  'postgres://twenty-mi@qr-pg.postgres.database.azure.com:5432/twenty?sslmode=require';

const getToken = jest.fn();

jest.mock(
  '@azure/identity',
  () => ({
    ManagedIdentityCredential: jest
      .fn()
      .mockImplementation(() => ({ getToken })),
    DefaultAzureCredential: jest.fn().mockImplementation(() => ({ getToken })),
  }),
  { virtual: true },
);

// The module memoizes its credential and token, so each test loads it fresh.
const loadModule = () =>
  // oxlint-disable-next-line typescript/no-require-imports
  require('src/database/typeorm/database-auth') as typeof import('src/database/typeorm/database-auth');

describe('database-auth', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    getToken.mockReset();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PG_DATABASE_AUTH_MODE;
    delete process.env.PG_DATABASE_AZURE_CLIENT_ID;
    delete process.env.PG_DATABASE_AZURE_USE_DEFAULT_CREDENTIAL_CHAIN;
    delete process.env.PG_SSL_ALLOW_SELF_SIGNED;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('buildDatabaseAuthExtra', () => {
    it('contributes nothing when the auth mode is unset', () => {
      expect(loadModule().buildDatabaseAuthExtra(AZURE_URL)).toEqual({});
    });

    it('contributes nothing when the auth mode is explicitly PASSWORD', () => {
      process.env.PG_DATABASE_AUTH_MODE = DatabaseAuthMode.PASSWORD;

      expect(loadModule().buildDatabaseAuthExtra(AZURE_URL)).toEqual({});
    });

    it('supplies a password callback in AZURE_MANAGED_IDENTITY mode', () => {
      process.env.PG_DATABASE_AUTH_MODE =
        DatabaseAuthMode.AZURE_MANAGED_IDENTITY;

      expect(
        typeof loadModule().buildDatabaseAuthExtra(AZURE_URL).password,
      ).toBe('function');
    });

    it('accepts lowercase and kebab-case spellings of the auth mode', () => {
      process.env.PG_DATABASE_AUTH_MODE = 'azure-managed-identity';

      expect(
        typeof loadModule().buildDatabaseAuthExtra(AZURE_URL).password,
      ).toBe('function');
    });

    it('throws on an unrecognised auth mode rather than silently ignoring it', () => {
      process.env.PG_DATABASE_AUTH_MODE = 'gcp-iam';

      expect(() => loadModule().buildDatabaseAuthExtra(AZURE_URL)).toThrow(
        /Invalid PG_DATABASE_AUTH_MODE "gcp-iam"/,
      );
    });

    it('refuses to send a token over a connection that disables TLS', () => {
      process.env.PG_DATABASE_AUTH_MODE =
        DatabaseAuthMode.AZURE_MANAGED_IDENTITY;

      expect(() =>
        loadModule().buildDatabaseAuthExtra(
          'postgres://mi@host:5432/db?sslmode=disable',
        ),
      ).toThrow(/must not travel in cleartext/);
    });

    it('rejects sslmode=disable whatever its casing', () => {
      process.env.PG_DATABASE_AUTH_MODE =
        DatabaseAuthMode.AZURE_MANAGED_IDENTITY;

      expect(() =>
        loadModule().buildDatabaseAuthExtra(
          'postgres://mi@host:5432/db?sslmode=DISABLE',
        ),
      ).toThrow(/must not travel in cleartext/);
    });

    // Read straight off process.env here, but surfaced through
    // TwentyConfigService elsewhere; the two must agree on what "true" means.
    it.each(['true', 'TRUE', 'on', 'yes', '1'])(
      'treats PG_SSL_ALLOW_SELF_SIGNED=%s the way TwentyConfigService does',
      (value) => {
        process.env.PG_DATABASE_AUTH_MODE =
          DatabaseAuthMode.AZURE_MANAGED_IDENTITY;
        process.env.PG_SSL_ALLOW_SELF_SIGNED = value;

        expect(loadModule().buildDatabaseAuthExtra(AZURE_URL).ssl).toEqual({
          rejectUnauthorized: false,
        });
      },
    );

    it.each(['false', 'off', 'no', '0', ''])(
      'keeps certificate verification on for PG_SSL_ALLOW_SELF_SIGNED=%s',
      (value) => {
        process.env.PG_DATABASE_AUTH_MODE =
          DatabaseAuthMode.AZURE_MANAGED_IDENTITY;
        process.env.PG_SSL_ALLOW_SELF_SIGNED = value;

        expect(loadModule().buildDatabaseAuthExtra(AZURE_URL).ssl).toEqual({
          rejectUnauthorized: true,
        });
      },
    );

    it('relaxes certificate verification only when PG_SSL_ALLOW_SELF_SIGNED is set', () => {
      process.env.PG_DATABASE_AUTH_MODE =
        DatabaseAuthMode.AZURE_MANAGED_IDENTITY;

      expect(loadModule().buildDatabaseAuthExtra(AZURE_URL).ssl).toEqual({
        rejectUnauthorized: true,
      });

      jest.resetModules();
      process.env.PG_SSL_ALLOW_SELF_SIGNED = 'true';

      expect(loadModule().buildDatabaseAuthExtra(AZURE_URL).ssl).toEqual({
        rejectUnauthorized: false,
      });
    });
  });

  // Regression tests for the layer that actually consumes this config. TypeORM
  // merging `extra` last is necessary but not sufficient: `pg` re-parses
  // `connectionString` afterwards and would otherwise clobber the callback and
  // drop TLS. Asserting on the built object alone does not catch either.
  describe('the pg client TypeORM ultimately builds', () => {
    // `connectionParameters` is what pg actually connects with, after it has
    // re-parsed the connection string. It is internal, hence the cast.
    const connectionParametersOf = (client: Client) =>
      (
        client as unknown as {
          connectionParameters: { ssl: unknown; host: string };
        }
      ).connectionParameters;

    const buildPgClient = (extra: Record<string, unknown>) =>
      // Mirrors PostgresDriver.createPool: TypeORM's own keys first, `extra` last.
      new Client({
        connectionString: AZURE_URL,
        host: 'qr-pg.postgres.database.azure.com',
        user: 'twenty-mi',
        password: undefined,
        database: 'twenty',
        port: 5432,
        ssl: undefined,
        ...extra,
      });

    it('still carries the token callback once pg has parsed the config', () => {
      process.env.PG_DATABASE_AUTH_MODE =
        DatabaseAuthMode.AZURE_MANAGED_IDENTITY;

      const client = buildPgClient(
        loadModule().buildDatabaseAuthExtra(AZURE_URL),
      );

      expect(typeof client.password).toBe('function');
    });

    it('never falls back to PGPASSWORD', () => {
      process.env.PG_DATABASE_AUTH_MODE =
        DatabaseAuthMode.AZURE_MANAGED_IDENTITY;
      process.env.PGPASSWORD = 'an-unrelated-secret';

      const client = buildPgClient(
        loadModule().buildDatabaseAuthExtra(AZURE_URL),
      );

      expect(client.password).not.toBe('an-unrelated-secret');

      delete process.env.PGPASSWORD;
    });

    it('keeps TLS enabled', () => {
      process.env.PG_DATABASE_AUTH_MODE =
        DatabaseAuthMode.AZURE_MANAGED_IDENTITY;

      const client = buildPgClient(
        loadModule().buildDatabaseAuthExtra(AZURE_URL),
      );

      expect(connectionParametersOf(client).ssl).toEqual({
        rejectUnauthorized: true,
      });
    });

    it('leaves the connection untouched in PASSWORD mode', () => {
      const client = buildPgClient(
        loadModule().buildDatabaseAuthExtra(AZURE_URL),
      );

      expect(connectionParametersOf(client).host).toBe(
        'qr-pg.postgres.database.azure.com',
      );
      expect(connectionParametersOf(client).ssl).toEqual({});
    });
  });

  // The tests above build the pg config the way PostgresDriver.createPool
  // *would*. That is not the same as letting TypeORM build it, and the
  // difference is not academic: an earlier version of this module cleared
  // `connectionString` while assuming TypeORM would supply host/user/database
  // separately. It does not, so the pool silently fell back to pg's defaults
  // and the app connected to localhost:5432 in production while every test
  // here passed. These drive a real DataSource instead.
  describe('a real TypeORM DataSource', () => {
    const connectVia = async (url: string) => {
      // oxlint-disable-next-line typescript/no-require-imports
      const { DataSource } = require('typeorm') as typeof import('typeorm');
      const { buildDatabaseAuthExtra } = loadModule();

      const dataSource = new DataSource({
        url,
        type: 'postgres',
        logging: [],
        extra: buildDatabaseAuthExtra(url),
      });

      try {
        await dataSource.initialize();

        throw new Error('expected the connection to fail');
      } catch (error) {
        // `address` and `port` are present on a socket-level failure but are
        // not part of the ErrnoException type.
        return error as NodeJS.ErrnoException & {
          address?: string;
          port?: number;
        };
      }
    };

    // Port 1 is reserved and nothing listens on it, so this fails fast without
    // touching the network. What matters is *where* it fails: the address and
    // port have to be the ones from the URL, not pg's localhost:5432 default.
    it('connects to the host and port from the URL, not pg defaults', async () => {
      process.env.PG_DATABASE_AUTH_MODE =
        DatabaseAuthMode.AZURE_MANAGED_IDENTITY;

      const error = await connectVia('postgres://mi@127.0.0.1:1/twenty');

      expect(error.code).toBe('ECONNREFUSED');
      expect(error.port).toBe(1);
    });

    it('refuses a URL it cannot read a target from, rather than defaulting', () => {
      process.env.PG_DATABASE_AUTH_MODE =
        DatabaseAuthMode.AZURE_MANAGED_IDENTITY;

      const { buildDatabaseAuthExtra } = loadModule();

      expect(() => buildDatabaseAuthExtra('not-a-url')).toThrow(
        /no host, user and database could be read/,
      );
    });

    it('carries the target through to the pg config', () => {
      process.env.PG_DATABASE_AUTH_MODE =
        DatabaseAuthMode.AZURE_MANAGED_IDENTITY;

      expect(loadModule().buildDatabaseAuthExtra(AZURE_URL)).toMatchObject({
        host: 'qr-pg.postgres.database.azure.com',
        port: 5432,
        user: 'twenty-mi',
        database: 'twenty',
      });
    });
  });

  describe('getAzureDatabaseAccessToken', () => {
    const inOneHour = () => Date.now() + 60 * 60 * 1000;

    it('shares one request across concurrent callers', async () => {
      getToken.mockResolvedValue({
        token: 'token-1',
        expiresOnTimestamp: inOneHour(),
      });

      const { getAzureDatabaseAccessToken } = loadModule();

      const tokens = await Promise.all(
        Array.from({ length: 10 }, () => getAzureDatabaseAccessToken()),
      );

      expect(tokens).toEqual(Array.from({ length: 10 }, () => 'token-1'));
      // A pool ramping up must not fan out to a rate-limited identity endpoint.
      expect(getToken).toHaveBeenCalledTimes(1);
    });

    it('reuses a cached token on later calls', async () => {
      getToken.mockResolvedValue({
        token: 'token-1',
        expiresOnTimestamp: inOneHour(),
      });

      const { getAzureDatabaseAccessToken } = loadModule();

      await getAzureDatabaseAccessToken();
      await getAzureDatabaseAccessToken();

      expect(getToken).toHaveBeenCalledTimes(1);
    });

    it('re-mints a token that is inside the expiry skew', async () => {
      getToken
        .mockResolvedValueOnce({
          token: 'nearly-expired',
          expiresOnTimestamp: Date.now() + 60 * 1000,
        })
        .mockResolvedValueOnce({
          token: 'fresh',
          expiresOnTimestamp: inOneHour(),
        });

      const { getAzureDatabaseAccessToken } = loadModule();

      expect(await getAzureDatabaseAccessToken()).toBe('nearly-expired');
      expect(await getAzureDatabaseAccessToken()).toBe('fresh');
      expect(getToken).toHaveBeenCalledTimes(2);
    });

    it('retries after a failure instead of caching it', async () => {
      getToken
        .mockRejectedValueOnce(new Error('identity endpoint unavailable'))
        .mockResolvedValueOnce({
          token: 'recovered',
          expiresOnTimestamp: inOneHour(),
        });

      const { getAzureDatabaseAccessToken } = loadModule();

      await expect(getAzureDatabaseAccessToken()).rejects.toThrow(
        'identity endpoint unavailable',
      );
      expect(await getAzureDatabaseAccessToken()).toBe('recovered');
    });

    // The in-flight request is shared, so an acquisition that never settles
    // would otherwise park every subsequent connection behind it forever.
    it('bounds a token request that never settles, and retries afterwards', async () => {
      jest.useFakeTimers();

      try {
        getToken.mockReturnValueOnce(new Promise(() => {}));

        const { getAzureDatabaseAccessToken } = loadModule();
        const timedOut = getAzureDatabaseAccessToken();
        const assertion = expect(timedOut).rejects.toThrow(/Timed out after/);

        await jest.advanceTimersByTimeAsync(30 * 1000);
        await assertion;

        getToken.mockResolvedValueOnce({
          token: 'after-timeout',
          expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
        });

        await expect(getAzureDatabaseAccessToken()).resolves.toBe(
          'after-timeout',
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('raises a clear error when the credential chain returns no token', async () => {
      getToken.mockResolvedValue(null);

      const { getAzureDatabaseAccessToken } = loadModule();

      await expect(getAzureDatabaseAccessToken()).rejects.toThrow(
        /returned no token/,
      );
    });

    it('uses managed identity rather than the broad credential chain by default', async () => {
      getToken.mockResolvedValue({
        token: 'token-1',
        expiresOnTimestamp: inOneHour(),
      });

      const { getAzureDatabaseAccessToken } = loadModule();

      await getAzureDatabaseAccessToken();

      // oxlint-disable-next-line typescript/no-require-imports
      const identity = require('@azure/identity');

      expect(identity.ManagedIdentityCredential).toHaveBeenCalledTimes(1);
      expect(identity.DefaultAzureCredential).not.toHaveBeenCalled();
    });

    it('uses the broad credential chain only when explicitly asked', async () => {
      process.env.PG_DATABASE_AZURE_USE_DEFAULT_CREDENTIAL_CHAIN = 'true';
      getToken.mockResolvedValue({
        token: 'token-1',
        expiresOnTimestamp: inOneHour(),
      });

      const { getAzureDatabaseAccessToken } = loadModule();

      await getAzureDatabaseAccessToken();

      // oxlint-disable-next-line typescript/no-require-imports
      const identity = require('@azure/identity');

      expect(identity.DefaultAzureCredential).toHaveBeenCalledTimes(1);
      expect(identity.ManagedIdentityCredential).not.toHaveBeenCalled();
    });
  });
});
