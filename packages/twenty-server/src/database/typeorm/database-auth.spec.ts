import {
  buildDatabaseAuthExtra,
  resetDatabaseAuthCacheForTesting,
} from 'src/database/typeorm/database-auth';
import { DatabaseAuthMode } from 'src/database/typeorm/interfaces/database-auth-mode.interface';

describe('buildDatabaseAuthExtra', () => {
  const originalAuthMode = process.env.PG_DATABASE_AUTH_MODE;

  afterEach(() => {
    if (originalAuthMode === undefined) {
      delete process.env.PG_DATABASE_AUTH_MODE;
    } else {
      process.env.PG_DATABASE_AUTH_MODE = originalAuthMode;
    }
    resetDatabaseAuthCacheForTesting();
  });

  it('contributes nothing when the auth mode is unset', () => {
    delete process.env.PG_DATABASE_AUTH_MODE;

    expect(buildDatabaseAuthExtra()).toEqual({});
  });

  it('contributes nothing when the auth mode is explicitly PASSWORD', () => {
    process.env.PG_DATABASE_AUTH_MODE = DatabaseAuthMode.PASSWORD;

    expect(buildDatabaseAuthExtra()).toEqual({});
  });

  it('supplies a password callback in AZURE_MANAGED_IDENTITY mode', () => {
    process.env.PG_DATABASE_AUTH_MODE = DatabaseAuthMode.AZURE_MANAGED_IDENTITY;

    // `pg` invokes this per new connection, which is what keeps a pool alive
    // across token expiry.
    expect(typeof buildDatabaseAuthExtra().password).toBe('function');
  });

  it('accepts lowercase and kebab-case spellings of the auth mode', () => {
    process.env.PG_DATABASE_AUTH_MODE = 'azure-managed-identity';

    expect(typeof buildDatabaseAuthExtra().password).toBe('function');
  });

  it('throws on an unrecognised auth mode rather than silently ignoring it', () => {
    process.env.PG_DATABASE_AUTH_MODE = 'gcp-iam';

    expect(() => buildDatabaseAuthExtra()).toThrow(
      /Invalid PG_DATABASE_AUTH_MODE "gcp-iam"/,
    );
  });
});
