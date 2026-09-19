import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Replaces `ledger_transactions.kind`'s CHECK list with the dotted `domain.event` vocabulary the
 * design documents have always used — see docs/decisions/0016-transaction-kind-vocabulary.md.
 *
 * The 2026-09-06 audit found the CHECK from 1754006400001 and every document describing a posting
 * had never agreed: the canonical worked $100 on-ramp in docs/architecture.md §3.3 posts
 * `onramp.capture`/`.fx`/`.reserve`/`.settled`, none of which the constraint accepted, and the list
 * had no `fx` or `reserve` kind at all — so Part 6 could not have expressed the documented
 * four-posting flow.
 *
 * `kind` is half of `UNIQUE(kind, cause_type, cause_id)`, the ledger's idempotency key. Rewriting it
 * is only safe while no rows exist: renaming a kind after the fact orphans the idempotency of every
 * transaction posted under the old name, so re-delivery of an already-posted cause would no longer
 * collide and would post duplicate entries. **From here the set is append-only** — add a kind, never
 * rename or remove one, exactly as ADR-0014 requires of retired statuses.
 */
export class LedgerTransactionKinds1754006400006 implements MigrationInterface {
  name = "LedgerTransactionKinds1754006400006";

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check
    `);
    await queryRunner.query(`
      ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK (kind IN (
        'payment_captured', 'payment_settled',
        'payout_requested', 'payout_settled',
        'refund_initiated', 'chargeback_received',
        'on_ramp_completed', 'rounding_residual'
      ))
    `);
  }
}
