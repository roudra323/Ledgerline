import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from "typeorm";

import { BaseAuditEntity } from "../../common/entities/base-audit.entity";

import { LedgerEntry } from "./ledger-entry.entity";

/**
 * All valid business event kinds posted to the double-entry ledger, grouped by the saga that emits
 * them — see docs/decisions/0016-transaction-kind-vocabulary.md.
 *
 * The CHECK constraint in the newest migration that defines it owns this list; this union is a
 * description of it. `pnpm docs:check` fails the build if the two drift apart, or if a document
 * posts a kind the constraint would reject.
 *
 * Append-only: `kind` is half of `UNIQUE(kind, cause_type, cause_id)`, so renaming one would orphan
 * the idempotency of every transaction already posted under it.
 */
export type TransactionKind =
  | "onramp.capture"
  | "onramp.fx"
  | "onramp.reserve"
  | "onramp.settled"
  | "refund.initiated"
  | "refund.chain_reversed"
  | "refund.fiat_returned"
  | "payout.requested"
  | "payout.burned"
  | "payout.settled"
  | "payout.returned"
  | "chargeback.received"
  | "fx.residual"
  | "treasury.mint"
  | "treasury.psp_sweep"
  | "compliance.frozen"
  | "reconciliation.adjustment";

/**
 * LedgerTransaction Entity — maps the `ledger_transactions` database table.
 *
 * Represents an immutable business event. The `UNIQUE(kind, cause_type, cause_id)` constraint
 * guarantees database-level idempotency — duplicate webhooks/events fail harmlessly at the DB.
 */
@Entity("ledger_transactions")
@Index("ledger_transactions_cause_uk", ["kind", "causeType", "causeId"], { unique: true })
export class LedgerTransaction extends BaseAuditEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "kind", type: "text" })
  kind!: TransactionKind;

  @Column({ name: "cause_type", type: "text" })
  causeType!: string;

  @Column({ name: "cause_id", type: "text" })
  causeId!: string;

  /**
   * Business timestamp of the event. Set explicitly by LedgerService.post() so replays
   * can back-date postings to their original time. DB default covers the normal path.
   */
  @Column({ name: "posted_at", type: "timestamptz", default: () => "now()" })
  postedAt!: Date;

  @Column({ name: "metadata", type: "jsonb", nullable: true })
  metadata!: Record<string, unknown> | null;

  /**
   * When set, this transaction is a correction that nullifies an earlier transaction.
   * Corrections are ALWAYS new, opposite transactions — never edits to the original row.
   * The database enforces this: UPDATE/DELETE on ledger_transactions throws (Block 1.5).
   */
  @Column({ name: "reverses_id", type: "uuid", nullable: true })
  reversesId!: string | null;

  @ManyToOne(() => LedgerTransaction, { nullable: true, onDelete: "RESTRICT" })
  @JoinColumn({ name: "reverses_id" })
  reversesTransaction!: LedgerTransaction | null;

  @OneToMany(() => LedgerEntry, (entry) => entry.transaction)
  entries!: LedgerEntry[];
}
