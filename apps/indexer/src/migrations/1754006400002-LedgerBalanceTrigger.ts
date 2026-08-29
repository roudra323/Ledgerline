import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Migration adding the deferred constraint trigger that makes an unbalanced
 * ledger_transaction impossible to commit: `Σ debits = Σ credits`, per asset_code.
 *
 * Deferred (checked at COMMIT, not per-row) because ledger_entries insert one row
 * at a time — after the first row of a transaction the books are momentarily
 * "unbalanced" by design, and a non-deferred trigger would reject valid inserts.
 */
export class LedgerBalanceTrigger1754006400002 implements MigrationInterface {
  name = "LedgerBalanceTrigger1754006400002";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION assert_transaction_balances() RETURNS trigger AS $$
      DECLARE
        bad record;
      BEGIN
        SELECT asset_code,
               SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END) AS residual
          INTO bad
          FROM ledger_entries
         WHERE transaction_id = NEW.transaction_id
         GROUP BY asset_code
        HAVING SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END) <> 0
         LIMIT 1;

        IF FOUND THEN
          RAISE EXCEPTION 'ledger transaction % is unbalanced in % by %',
            NEW.transaction_id, bad.asset_code, bad.residual;
        END IF;

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER ledger_entries_balance_check
        AFTER INSERT ON ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_transaction_balances()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS ledger_entries_balance_check ON ledger_entries`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS assert_transaction_balances()`);
  }
}
