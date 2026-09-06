import type { AmountMinor, AssetCode } from "@ledgerline/shared";

import type { EntryDirection } from "./entities/ledger-entry.entity";
import type { TransactionKind } from "./entities/ledger-transaction.entity";

/**
 * Identifies the event that caused a posting. Paired with `kind`, this is the idempotency key —
 * `ledger_transactions.UNIQUE(kind, cause_type, cause_id)` makes posting the same cause twice a
 * no-op instead of a duplicate.
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
  readonly entries: readonly PostingLeg[];
}

export interface PostingResult {
  readonly transactionId: string;
  /** True when `cause` had already been posted — post() was a no-op, not an error. */
  readonly alreadyPosted: boolean;
}
