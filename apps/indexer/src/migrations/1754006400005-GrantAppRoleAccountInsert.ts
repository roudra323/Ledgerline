import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Block 1.6 surfaced a gap in the Block 1.5 grant set: AccountRegistryService creates
 * per-merchant ledger_accounts rows on demand, at runtime, as the ledgerline_app role — but
 * 1754006400003-LedgerImmutability.ts only granted it SELECT on ledger_accounts, treating it as
 * pure reference data. Adds INSERT only; UPDATE/DELETE remain ungranted, since nothing in the
 * design calls for the app to rewrite or remove an account once created.
 */
export class GrantAppRoleAccountInsert1754006400005 implements MigrationInterface {
  name = "GrantAppRoleAccountInsert1754006400005";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`GRANT INSERT ON ledger_accounts TO ledgerline_app`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE INSERT ON ledger_accounts FROM ledgerline_app`);
  }
}
