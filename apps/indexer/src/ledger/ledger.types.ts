import type { AmountMinor, AssetCode } from "@ledgerline/shared";

import type { EntryDirection } from "./entities/ledger-entry.entity";
import type { TransactionKind } from "./entities/ledger-transaction.entity";

/**
 * Identifies the event that caused a posting. Paired with `kind`, this is the idempotency key —
 * `ledger_transactions.UNIQUE(kind, cause_type, cause_id)` makes posting the same cause twice a
 * no-op instead of a duplicate.
 *
 * TODO(Block 5.2): `type` is free text with no `CHECK`, while `kind` — the other half of the same
 * key — has a bounded union and a constraint that `pnpm docs:check` cross-validates. A half
 * constrained idempotency key is a duplicate-credit bug waiting for a typo: posting
 * `"fiat_event"` from one path and `"fiatEvent"` from another defeats the UNIQUE silently and
 * credits twice. Give it the same treatment once Block 5.2 fixes the set of cause types the two
 * logs actually emit — before any saga becomes a real caller.
 */
export interface LedgerCause {
  readonly type: string;
  readonly id: string;
}

/**
 * One debit or credit line of a posting. `accountCode` is a chart-of-accounts code
 * (e.g. `"1000"`), never a UUID — `LedgerService` resolves it via `AccountRegistryService`.
 * `merchantId` is required for per-merchant account codes (e.g. `"2000"`) and omitted for
 * platform singleton accounts.
 */
export interface PostingLeg {
  readonly accountCode: string;
  readonly direction: EntryDirection;
  readonly assetCode: AssetCode;
  readonly amountMinor: AmountMinor;
  readonly merchantId?: string;
}

export interface PostingRequest {
  readonly kind: TransactionKind;
  readonly cause: LedgerCause;
  readonly memo?: string;
  /**
   * Business time of the event, not wall-clock insert time. Omit on the live path and the database
   * default (`now()`) applies; a replay MUST supply the original time, or rebuilt history is stamped
   * with the replay's clock and Part 4's replay-determinism deep-equal fails.
   */
  readonly postedAt?: Date;
  readonly entries: readonly PostingLeg[];
}

export interface PostingResult {
  readonly transactionId: string;
  /** True when `cause` had already been posted — post() was a no-op, not an error. */
  readonly alreadyPosted: boolean;
}
