import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Appends the five kinds that docs/decisions/0018-ledger-flow-postings.md needs to make every
 * documented flow postable. The set is append-only (ADR-0016), so this re-adds 1754006400006's twelve
 * unchanged and only adds to them.
 *
 * - `treasury.mint` — issuance is a treasury operation, not part of a payment (ADR-0013). Before this
 *   the documented on-ramp credited `2500 stablecoin_issued` on every payment, which made I3 drift.
 * - `treasury.psp_sweep` — the PSP paying our balance out to our bank. Without it `1010
 *   bank_settlement` can never hold the cash a fiat payout draws on.
 * - `payout.returned` — a bounced ACH/SEPA payout re-opens the obligation (failure mode A16).
 * - `compliance.frozen` — a destination blacklisted before settlement moves the payable to
 *   `2200 frozen_payable` (failure mode B16).
 * - `reconciliation.adjustment` — the separately-invoked auto-heal that docs/runbook.md names.
 */
export class LedgerTreasuryKinds1754006400008 implements MigrationInterface {
  name = "LedgerTreasuryKinds1754006400008";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check
    `);
    await queryRunner.query(`
      ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK (kind IN (
        'onramp.capture', 'onramp.fx', 'onramp.reserve', 'onramp.settled',
        'refund.initiated', 'refund.chain_reversed', 'refund.fiat_returned',
        'payout.requested', 'payout.burned', 'payout.settled', 'payout.returned',
        'chargeback.received', 'fx.residual',
        'treasury.mint', 'treasury.psp_sweep',
        'compliance.frozen', 'reconciliation.adjustment'
      ))
    `);
  }

  /** Restores 1754006400006's twelve — only safe while no row uses a kind this migration added. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check
    `);
    await queryRunner.query(`
      ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK (kind IN (
        'onramp.capture', 'onramp.fx', 'onramp.reserve', 'onramp.settled',
        'refund.initiated', 'refund.chain_reversed', 'refund.fiat_returned',
        'payout.requested', 'payout.burned', 'payout.settled',
        'chargeback.received', 'fx.residual'
      ))
    `);
  }
}
