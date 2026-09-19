import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Closes a gap between docs/architecture.md §2.2 / ADR-0004 (which describe THREE enforcement
 * layers — immutability, balance, and non-negative) and the migrations so far: immutability is its
 * own trigger (1754006400003) and 1754006400002-LedgerBalanceTrigger.ts checked balance only, so
 * nothing enforced the third.
 *
 * Extends assert_transaction_balances() (CREATE OR REPLACE — same function, same trigger
 * attachment from Block 1.4, no need to touch the CONSTRAINT TRIGGER itself) to also reject any
 * account with allows_negative = false whose running balance would be negative after this
 * transaction commits. `ledger_account_balances` (Block 1.7) doesn't exist as a reliable running
 * total yet, so the check derives the balance directly from ledger_entries, signed by each
 * account's own normal_side.
 */
export class LedgerNonNegativeCheck1754006400004 implements MigrationInterface {
  name = "LedgerNonNegativeCheck1754006400004";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_transaction_balances() RETURNS trigger AS $$
      DECLARE
        bad record;
        account_normal_side text;
        account_allows_negative boolean;
        account_balance numeric(38,0);
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

        SELECT normal_side, allows_negative
          INTO account_normal_side, account_allows_negative
          FROM ledger_accounts
         WHERE id = NEW.account_id;

        SELECT SUM(CASE WHEN direction = account_normal_side THEN amount_minor ELSE -amount_minor END)
          INTO account_balance
          FROM ledger_entries
         WHERE account_id = NEW.account_id;

        IF NOT account_allows_negative AND account_balance < 0 THEN
          RAISE EXCEPTION 'ledger account % went negative (balance %) but allows_negative = false',
            NEW.account_id, account_balance;
        END IF;

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the Block 1.4 function body — balance check only, no non-negative check.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_transaction_balances() RETURNS trigger AS $$
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
  }
}
