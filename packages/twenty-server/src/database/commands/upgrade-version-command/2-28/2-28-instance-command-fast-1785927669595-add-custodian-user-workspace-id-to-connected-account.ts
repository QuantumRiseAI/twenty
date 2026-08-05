import { type QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { type FastInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/fast-instance-command.interface';

@RegisteredInstanceCommand('2.28.0', 1785927669595)
export class AddCustodianUserWorkspaceIdToConnectedAccountFastInstanceCommand
  implements FastInstanceCommand
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "core"."connectedAccount" ADD COLUMN IF NOT EXISTS "custodianUserWorkspaceId" uuid',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "core"."connectedAccount" DROP COLUMN IF EXISTS "custodianUserWorkspaceId"',
    );
  }
}
