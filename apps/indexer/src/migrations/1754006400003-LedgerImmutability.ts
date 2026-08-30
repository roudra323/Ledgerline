import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Block 1.5 — makes ledger_entries and ledger_transactions immutable at the database level.
 *
 * Three layers, in order:
 *   1. A least-privilege `ledgerline_app` role, distinct from the table-owning migration role.
 *      Ownership always bypasses REVOKE in Postgres, so without a separate role the REVOKE
 *      below would be theatre — it would restrict no one.
 *   2. REVOKE UPDATE, DELETE from that role on the two log tables — belt and braces. The trigger
 *      is the real enforcement (it fires for owners too); the REVOKE means even a future bug in
 *      application code cannot ask Postgres for an UPDATE/DELETE that would succeed.
 *   3. A BEFORE UPDATE OR DELETE trigger raising on both tables, plus `reverses_id` on
 *      ledger_transactions — corrections are new, opposite transactions, never edits.
 */
export class LedgerImmutability1754006400003 implements MigrationInterface {
  name = "LedgerImmutability1754006400003";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.createAppRole(queryRunner);
    await this.grantAppRolePrivileges(queryRunner);
    await this.addReversesIdColumn(queryRunner);
    await this.createImmutabilityTrigger(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.dropImmutabilityTrigger(queryRunner);
    await this.dropReversesIdColumn(queryRunner);
    await this.dropAppRole(queryRunner);
  }

  private async createAppRole(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ledgerline_app') THEN
          CREATE ROLE ledgerline_app LOGIN PASSWORD 'ledgerline_app';
        END IF;
      END
      $$
    `);
  }

  private async grantAppRolePrivileges(queryRunner: QueryRunner): Promise<void> {
    const database = await currentDatabase(queryRunner);
    await queryRunner.query(`GRANT CONNECT ON DATABASE ${database} TO ledgerline_app`);
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO ledgerline_app`);

    // Reference data the app only ever reads.
    await queryRunner.query(`GRANT SELECT ON assets, ledger_accounts TO ledgerline_app`);

    // The append-only logs: the app may read and insert, never edit history.
    await queryRunner.query(
      `GRANT SELECT, INSERT ON ledger_transactions, ledger_entries TO ledgerline_app`,
    );

    // The balances projection is a disposable cache — the app is allowed to maintain it (Block 1.7).
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE ON ledger_account_balances TO ledgerline_app`,
    );

    // Belt and braces on top of the trigger below — even a future app-code bug can't ask
    // Postgres for an UPDATE/DELETE that would succeed.
    await queryRunner.query(
      `REVOKE UPDATE, DELETE ON ledger_transactions, ledger_entries FROM ledgerline_app`,
    );
  }

  // ledger_entries already has an entry-level reverses_id from Block 1.3; this is the
  // transaction-level equivalent for whole-event reversals.
  private async addReversesIdColumn(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ledger_transactions
        ADD COLUMN reverses_id uuid NULL REFERENCES ledger_transactions (id)
    `);
  }

  private async dropReversesIdColumn(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ledger_transactions DROP COLUMN IF EXISTS reverses_id`);
  }

  private async createImmutabilityTrigger(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          '% is immutable — post a reversing transaction instead of %-ing row %',
          TG_TABLE_NAME, lower(TG_OP), COALESCE(OLD.id, NEW.id);
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER ledger_transactions_immutable
        BEFORE UPDATE OR DELETE ON ledger_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation()
    `);

    await queryRunner.query(`
      CREATE TRIGGER ledger_entries_immutable
        BEFORE UPDATE OR DELETE ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation()
    `);
  }

  private async dropImmutabilityTrigger(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS ledger_entries_immutable ON ledger_entries`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS ledger_transactions_immutable ON ledger_transactions`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS forbid_ledger_mutation()`);
  }

  private async dropAppRole(queryRunner: QueryRunner): Promise<void> {
    const database = await currentDatabase(queryRunner);
    await queryRunner.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ledgerline_app`,
    );
    await queryRunner.query(`REVOKE USAGE ON SCHEMA public FROM ledgerline_app`);
    await queryRunner.query(`REVOKE CONNECT ON DATABASE ${database} FROM ledgerline_app`);
    await queryRunner.query(`DROP ROLE IF EXISTS ledgerline_app`);
  }
}

/** Postgres GRANT/REVOKE ON DATABASE needs the literal db name — read it rather than hardcode it. */
async function currentDatabase(queryRunner: QueryRunner): Promise<string> {
  const result = (await queryRunner.query(`SELECT current_database()`)) as {
    current_database: string;
  }[];
  const row = result[0];
  if (!row) throw new Error("SELECT current_database() returned no row");
  return `"${row.current_database}"`;
}
