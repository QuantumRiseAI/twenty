export enum DatabaseAuthMode {
  /**
   * Authenticate with the credentials embedded in `PG_DATABASE_URL`. Default.
   */
  PASSWORD = 'PASSWORD',

  /**
   * Authenticate with a short-lived Microsoft Entra ID access token minted from
   * the ambient Azure identity, for Azure Database for PostgreSQL instances
   * that have password authentication disabled.
   */
  AZURE_MANAGED_IDENTITY = 'AZURE_MANAGED_IDENTITY',
}
