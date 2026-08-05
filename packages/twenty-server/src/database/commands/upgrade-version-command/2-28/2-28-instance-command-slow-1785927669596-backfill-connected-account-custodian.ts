import { type DataSource, type QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { type SlowInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/slow-instance-command.interface';

@RegisteredInstanceCommand('2.28.0', 1785927669596, { type: 'slow' })
export class BackfillConnectedAccountCustodianSlowInstanceCommand
  implements SlowInstanceCommand
{
  // Archiving was previously only reachable by handing a departed member's account
  // to someone else, and that hand-over overwrote userWorkspaceId with the recipient.
  // The original subject is unrecoverable, so record the current holder as custodian
  // to stop them reading the mailbox as if it were their own.
  async runDataMigration(dataSource: DataSource): Promise<void> {
    await dataSource.query(
      `UPDATE "core"."connectedAccount"
      SET "custodianUserWorkspaceId" = "userWorkspaceId"
      WHERE "archivedAt" IS NOT NULL
        AND "custodianUserWorkspaceId" IS NULL`,
    );
  }

  public async up(_queryRunner: QueryRunner): Promise<void> {}

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
