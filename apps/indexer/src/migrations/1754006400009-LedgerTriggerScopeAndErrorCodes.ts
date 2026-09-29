import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Two changes to the balance trigger's function, found reviewing it after the 2026-09-06 audit.
 * See docs/decisions/0019-ledger-trigger-error-contract.md.
 *
 * 1. **The row lock and the history scan now apply only where there is a floor to protect.**
 *    1754006400007 locked the account row and summed the account's full history for every entry,
 *    then consulted `allows_negative` only to decide whether to raise. For an account that may go
 *    negative (`1800`/`1810 fx_clearing`, `3900 rounding_residual`) both were pure cost: the check
 *    they fed could never fail, yet every on-ramp serialised on `1800` and `1810` behind that lock.
 *    The lock now carries `AND NOT allows_negative` in its predicate, so it returns — and locks — a
 *    row only when the account has a floor; otherwise the trigger returns before the scan.
 *
 * 2. **Every rejection carries its own SQLSTATE.** Both `RAISE EXCEPTION`s used the default
 *    `P0001`, so a caller could tell "the float is exhausted" (golden rule 7: park the saga) from "a
 *    bug built an unbalanced posting" (dead-letter it) only by matching message text. They now raise
 *    `LL001` (unbalanced) and `LL002` (non-negative floor breached). The messages are unchanged.
 *
 * `CREATE OR REPLACE` on the same function; 1754006400002's CONSTRAINT TRIGGER attachment is
 * untouched — supersede, never edit.
 */
export class LedgerTriggerScopeAndErrorCodes1754006400009 implements MigrationInterface {
  name = "LedgerTriggerScopeAndErrorCodes1754006400009";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(scopedBalanceFunction);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(unscopedBalanceFunction);
  }
}

const scopedBalanceFunction = `
  CREATE OR REPLACE FUNCTION assert_transaction_balances() RETURNS trigger AS $$
  DECLARE
    bad record;
    account_normal_side text;
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
        NEW.transaction_id, bad.asset_code, bad.residual
        USING ERRCODE = 'LL001';
    END IF;

    -- The lock serialises concurrent commits touching an account with a floor, so the balance read
    -- below cannot miss another transaction's uncommitted entries. FOR NO KEY UPDATE, not FOR
    -- UPDATE, for the reason 1754006400007 and ADR-0017 give: it must stay compatible with the KEY
    -- SHARE lock the composite foreign key takes at INSERT.
    --
    -- The allows_negative predicate is part of the locking read, not a separate read before it:
    -- under READ COMMITTED Postgres re-evaluates the WHERE clause on the locked row version, so the
    -- decision and the lock come from the same row, and an account that may go negative is never
    -- locked at all.
    SELECT normal_side
      INTO account_normal_side
      FROM ledger_accounts
     WHERE id = NEW.account_id AND NOT allows_negative
       FOR NO KEY UPDATE;

    IF NOT FOUND THEN
      RETURN NULL;
    END IF;

    -- TODO(Block 1.7): read the locked ledger_account_balances row instead of re-deriving from
    -- history. This scan is O(entries per account) on every insert into an account with a floor.
    SELECT SUM(CASE WHEN direction = account_normal_side THEN amount_minor ELSE -amount_minor END)
      INTO account_balance
      FROM ledger_entries
     WHERE account_id = NEW.account_id
       AND asset_code = NEW.asset_code;

    IF account_balance < 0 THEN
      RAISE EXCEPTION 'ledger account % went negative (balance %) but allows_negative = false',
        NEW.account_id, account_balance
        USING ERRCODE = 'LL002';
    END IF;

    RETURN NULL;
  END;
  $$ LANGUAGE plpgsql
     -- SECURITY DEFINER and a pinned search_path, unchanged from 1754006400007: the lock needs
     -- UPDATE privilege on ledger_accounts, which ledgerline_app deliberately does not have.
     SECURITY DEFINER
     SET search_path = pg_catalog, public
`;

/** 1754006400007's function verbatim — the version this migration replaces. */
const unscopedBalanceFunction = `
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
     WHERE id = NEW.account_id
       FOR NO KEY UPDATE;

    SELECT SUM(CASE WHEN direction = account_normal_side THEN amount_minor ELSE -amount_minor END)
      INTO account_balance
      FROM ledger_entries
     WHERE account_id = NEW.account_id
       AND asset_code = NEW.asset_code;

    IF NOT account_allows_negative AND account_balance < 0 THEN
      RAISE EXCEPTION 'ledger account % went negative (balance %) but allows_negative = false',
        NEW.account_id, account_balance;
    END IF;

    RETURN NULL;
  END;
  $$ LANGUAGE plpgsql
     SECURITY DEFINER
     SET search_path = pg_catalog, public
`;
