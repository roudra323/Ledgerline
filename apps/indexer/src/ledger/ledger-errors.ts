/**
 * The ledger's typed rejections. A saga must react differently to each — park on an exhausted
 * float, dead-letter a malformed posting, page on a conflicting replay — so they are distinct
 * classes a caller can `instanceof`, never message text it has to match. See ADR-0019.
 */

/** SQLSTATEs raised by `assert_transaction_balances()` (migration 1754006400009). */
export const LEDGER_UNBALANCED_SQLSTATE = "LL001";
export const LEDGER_NEGATIVE_BALANCE_SQLSTATE = "LL002";

/** Base class, so a caller can catch "any ledger rejection" without listing the subclasses. */
export abstract class LedgerRejectionError extends Error {
  /** A bounded value, safe as the `reason_class` metric label. */
  abstract readonly reasonClass: LedgerRejectionReason;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export type LedgerRejectionReason = "unbalanced" | "negative_balance" | "idempotency_conflict";

/** The database rejected a posting whose legs do not net to zero in some asset. A bug, not a state. */
export class LedgerUnbalancedError extends LedgerRejectionError {
  readonly reasonClass = "unbalanced";
}

/**
 * The database rejected a posting that would take an account with a floor below zero. For
 * `1100 token_treasury` this is the expected "float exhausted" signal a saga parks on.
 */
export class LedgerNegativeBalanceError extends LedgerRejectionError {
  readonly reasonClass = "negative_balance";
}

/**
 * The cause was already posted, with different legs. Replaying a cause is an idempotent no-op only
 * when it describes the same money movement; anything else means two code paths disagree about
 * what the event did, and acknowledging it as `alreadyPosted` would hide that.
 */
export class LedgerIdempotencyConflictError extends LedgerRejectionError {
  readonly reasonClass = "idempotency_conflict";
}

/**
 * Converts a database error raised by the balance trigger into its typed rejection, and returns
 * anything else unchanged, so a caller can always `throw toLedgerError(error)`.
 *
 * Exported for callers that pass `joinTransaction` to `LedgerService.post()`: the trigger is
 * deferred, so it fires at *their* COMMIT, where `post()` is no longer on the stack to translate it.
 */
export function toLedgerError(error: unknown): unknown {
  const sqlState = sqlStateOf(error);
  const options = { cause: error };
  const message = error instanceof Error ? error.message : String(error);

  if (sqlState === LEDGER_UNBALANCED_SQLSTATE) {
    return new LedgerUnbalancedError(message, options);
  }
  if (sqlState === LEDGER_NEGATIVE_BALANCE_SQLSTATE) {
    return new LedgerNegativeBalanceError(message, options);
  }
  return error;
}

/**
 * The SQLSTATE of a node-postgres error, whether raw or wrapped by TypeORM's `QueryFailedError`
 * (which copies the driver error's fields onto itself and also keeps it as `driverError`).
 */
function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") {
    return direct;
  }
  const driverError = (error as { driverError?: { code?: unknown } }).driverError;
  return typeof driverError?.code === "string" ? driverError.code : undefined;
}
