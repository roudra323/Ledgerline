import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Migration creating the core double-entry ledger tables:
 *   1. ledger_transactions     Immutable business events with UNIQUE(kind, cause_type, cause_id) idempotency
 *   2. ledger_entries          Immutable debit/credit lines with numeric(38,0) minor amounts & sequence order
 *   3. ledger_account_balances Calculated account balance totals (disposable projection)
 */
export class CreateLedgerTables1754006400001 implements MigrationInterface {
  name = "CreateLedgerTables1754006400001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. ledger_transactions ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE ledger_transactions (
        id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        kind        text        NOT NULL CHECK (kind IN (
                      'payment_captured', 'payment_settled',
                      'payout_requested', 'payout_settled',
                      'refund_initiated', 'chargeback_received',
                      'on_ramp_completed', 'rounding_residual'
                    )),
        cause_type  text        NOT NULL,
        cause_id    text        NOT NULL,
        posted_at   timestamptz NOT NULL DEFAULT now(),
        metadata    jsonb       NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ledger_transactions_cause_uk UNIQUE (kind, cause_type, cause_id)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX ledger_transactions_cause_idx ON ledger_transactions (cause_type, cause_id)
    `);

    // ── 2. ledger_entries ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE ledger_entries (
        id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id uuid          NOT NULL REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
        account_id     uuid          NOT NULL REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
        direction      text          NOT NULL CHECK (direction IN ('debit', 'credit')),
        asset_code     text          NOT NULL REFERENCES assets (asset_code),
        amount_minor   numeric(38,0) NOT NULL CHECK (amount_minor >= 0),
        sequence       smallint      NOT NULL CHECK (sequence >= 0),
        reverses_id    uuid          NULL REFERENCES ledger_entries (id),
        created_at     timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT ledger_entries_tx_seq_uk UNIQUE (transaction_id, sequence)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, created_at)
    `);

    // ── 3. ledger_account_balances ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE ledger_account_balances (
        account_id    uuid          PRIMARY KEY REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
        asset_code    text          NOT NULL REFERENCES assets (asset_code),
        balance_minor numeric(38,0) NOT NULL DEFAULT 0,
        last_entry_id uuid          NULL REFERENCES ledger_entries (id),
        created_at    timestamptz   NOT NULL DEFAULT now(),
        updated_at    timestamptz   NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ledger_account_balances CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS ledger_entries CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS ledger_transactions CASCADE`);
  }
}
