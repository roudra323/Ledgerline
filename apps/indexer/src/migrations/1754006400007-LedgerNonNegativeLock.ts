import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Closes two holes the 2026-09-06 audit found in the ledger's schema-level guarantees.
 *
 * 1. **The non-negative check was not concurrency-safe.** 1754006400004 derives an account's
 *    balance with a bare `SUM` over `ledger_entries`. It runs at COMMIT under READ COMMITTED, so it
 *    sees committed rows only: two transactions that reach their commit-time trigger together each
 *    read a balance excluding the other's rows, both pass, and an `allows_negative = false` account
 *    ends up negative. That is exactly Part 1's exit criterion — 20 concurrent payouts against float
 *    for 10 — which could yield 11. Locking the account row makes concurrent commits touching the
 *    same account queue behind each other, so the second reads a balance that includes the first.
 *
 * 2. **The sum ignored `asset_code`.** It added every entry for the account regardless of asset,
 *    safe only because accounts happen to be per-asset — an invariant enforced by a different table
 *    with nothing expressing the link. The composite foreign key below now enforces that link, and
 *    the sum filters by asset rather than relying on it.
 *
 * See docs/decisions/0017-non-negative-enforcement.md, including why a deadlock here is the correct
 * failure and not a regression, and why the function became SECURITY DEFINER.
 *
 * `CREATE OR REPLACE` on the same function, leaving 1754006400002's CONSTRAINT TRIGGER attachment
 * and 1754006400004 untouched — supersede, never edit.
 */
export class LedgerNonNegativeLock1754006400007 implements MigrationInterface {
  name = "LedgerNonNegativeLock1754006400007";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.bindEntryAssetToAccountAsset(queryRunner);
    await queryRunner.query(lockingBalanceFunction);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(unlockedBalanceFunction);
    await queryRunner.query(
      `ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_account_asset_fk`,
    );
    await queryRunner.query(
      `ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS ledger_accounts_id_asset_uk`,
    );
  }

  /**
   * An entry could name `USD` while pointing at a `USDX` account: nothing in the schema forbade it.
   * The application path was safe only by accident, and any second writer — a migration, a psql
   * session, Part 4's reorg reversal — had no guard at all. Per docs/conventions.md §9, that made it
   * a convention rather than a constraint.
   */
  private async bindEntryAssetToAccountAsset(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ledger_accounts
        ADD CONSTRAINT ledger_accounts_id_asset_uk UNIQUE (id, asset_code)
    `);
    await queryRunner.query(`
      ALTER TABLE ledger_entries
        ADD CONSTRAINT ledger_entries_account_asset_fk
        FOREIGN KEY (account_id, asset_code) REFERENCES ledger_accounts (id, asset_code)
    `);
  }
}

const lockingBalanceFunction = `
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

    -- FOR UPDATE is the whole point: it serialises concurrent commits touching this account, so the
    -- balance read below cannot miss another transaction's uncommitted entries.
    SELECT normal_side, allows_negative
      INTO account_normal_side, account_allows_negative
      FROM ledger_accounts
     WHERE id = NEW.account_id
       FOR UPDATE;

    -- TODO(Block 1.7): read the locked ledger_account_balances row instead of re-deriving from
    -- history. The projection row is the natural lock target, and this scan is O(entries per
    -- account) on every single insert, so it degrades for the life of the ledger.
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
     -- SECURITY DEFINER because the lock below needs UPDATE privilege on ledger_accounts, and
     -- ledgerline_app deliberately does not have it (1754006400003 grants SELECT + INSERT only —
     -- the app must never rewrite an account). The constraint is the schema's guarantee, not the
     -- caller's, so it runs as the table owner rather than weakening the app role's grants.
     -- search_path is pinned: an unqualified name inside a SECURITY DEFINER function is otherwise
     -- resolvable against a schema the caller controls.
     SECURITY DEFINER
     SET search_path = pg_catalog, public
`;

/** 1754006400004's function verbatim — the unlocked, asset-blind version this migration replaces. */
const unlockedBalanceFunction = `
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
`;
