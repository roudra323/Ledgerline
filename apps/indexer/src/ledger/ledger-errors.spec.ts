import {
  LEDGER_NEGATIVE_BALANCE_SQLSTATE,
  LEDGER_UNBALANCED_SQLSTATE,
  LedgerIdempotencyConflictError,
  LedgerNegativeBalanceError,
  LedgerRejectionError,
  LedgerUnbalancedError,
  toLedgerError,
} from "./ledger-errors";

/**
 * `toLedgerError()` is the single place a raw database rejection becomes a typed one a saga can
 * `instanceof`-switch on. Every claim below is either stated in the file's own docstrings or
 * implied by "returns anything else unchanged, so a caller can always `throw toLedgerError(error)`"
 * — a promise that only holds if every non-matching shape really does pass through untouched.
 */
describe("toLedgerError()", () => {
  it("maps a raw pg-style error (bare .code) with LL001 to LedgerUnbalancedError", () => {
    const raw = Object.assign(new Error("ledger transaction x is unbalanced in USD by 100"), {
      code: LEDGER_UNBALANCED_SQLSTATE,
    });

    const mapped = toLedgerError(raw);

    expect(mapped).toBeInstanceOf(LedgerUnbalancedError);
    expect(mapped).toBeInstanceOf(LedgerRejectionError);
    expect((mapped as LedgerUnbalancedError).message).toBe(raw.message);
  });

  it("maps a raw pg-style error with LL002 to LedgerNegativeBalanceError", () => {
    const raw = Object.assign(new Error("ledger account x went negative"), {
      code: LEDGER_NEGATIVE_BALANCE_SQLSTATE,
    });

    const mapped = toLedgerError(raw);

    expect(mapped).toBeInstanceOf(LedgerNegativeBalanceError);
  });

  it("maps a TypeORM QueryFailedError shape carrying the SQLSTATE only under .driverError.code", () => {
    // TypeORM's QueryFailedError copies driver fields onto itself, but the docstring also names
    // driverError as a fallback path — a caller that receives the unwrapped driver error (or a
    // TypeORM version that stops copying the field) must still be recognised.
    const wrapped = Object.assign(new Error("query failed"), {
      driverError: { code: LEDGER_NEGATIVE_BALANCE_SQLSTATE },
    });

    const mapped = toLedgerError(wrapped);

    expect(mapped).toBeInstanceOf(LedgerNegativeBalanceError);
  });

  it("prefers the top-level .code over a conflicting .driverError.code", () => {
    // Documents the precedence sqlStateOf() actually implements: direct `.code` wins outright,
    // `.driverError.code` is consulted only when `.code` is absent. A future refactor that flips
    // this order would silently change which class a given TypeORM error maps to.
    const contradictory = Object.assign(new Error("ambiguous"), {
      code: LEDGER_UNBALANCED_SQLSTATE,
      driverError: { code: LEDGER_NEGATIVE_BALANCE_SQLSTATE },
    });

    expect(toLedgerError(contradictory)).toBeInstanceOf(LedgerUnbalancedError);
  });

  it("returns an error with an unrelated SQLSTATE unchanged (same reference)", () => {
    // 23505 unique_violation — a real Postgres code, but not one this function owns. Returning a
    // NEW error here (even one that behaves like a passthrough) would break callers relying on
    // `instanceof` checks or `===` identity against the original.
    const unrelated = Object.assign(new Error("duplicate key value"), { code: "23505" });

    expect(toLedgerError(unrelated)).toBe(unrelated);
  });

  it("returns a plain Error with no .code at all unchanged", () => {
    const plain = new Error("something else entirely");

    expect(toLedgerError(plain)).toBe(plain);
  });

  it("returns a non-string .code unchanged — a numeric code must never accidentally match a SQLSTATE string", () => {
    // If sqlStateOf() ever compared loosely (== instead of a typeof guard), a numeric code that
    // happens to coerce to the right string could slip through.
    const numericCode = Object.assign(new Error("weird driver"), { code: 200 });

    expect(toLedgerError(numericCode)).toBe(numericCode);
  });

  it.each([null, undefined, "a bare string error", 42, true])(
    "returns non-object input %p unchanged rather than throwing",
    (value) => {
      expect(toLedgerError(value)).toBe(value);
    },
  );

  it("builds the message from String(error) when the input is not an Error instance", () => {
    // A plain object shaped like a driver error but not an Error — sqlStateOf() only requires
    // `typeof === "object"`, so this must not throw trying to read `.message`.
    const notAnError = { code: LEDGER_UNBALANCED_SQLSTATE };

    const mapped = toLedgerError(notAnError) as LedgerUnbalancedError;

    expect(mapped).toBeInstanceOf(LedgerUnbalancedError);
    // Deliberately pinning the ugly default stringification: toLedgerError() really does fall
    // back to `String(error)` for a non-Error input, so this is the exact string the assertion
    // must match, not a mistake to silence.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    expect(mapped.message).toBe(String(notAnError));
    expect(mapped.cause).toBe(notAnError);
  });

  it("preserves the original error as .cause on every mapped class", () => {
    const raw = Object.assign(new Error("x"), { code: LEDGER_UNBALANCED_SQLSTATE });
    expect((toLedgerError(raw) as LedgerUnbalancedError).cause).toBe(raw);
  });
});

describe("LedgerRejectionError subclasses", () => {
  it("each subclass reports the reasonClass the metrics label depends on", () => {
    expect(new LedgerUnbalancedError("x").reasonClass).toBe("unbalanced");
    expect(new LedgerNegativeBalanceError("x").reasonClass).toBe("negative_balance");
    expect(new LedgerIdempotencyConflictError("x").reasonClass).toBe("idempotency_conflict");
  });

  it("sets .name to the concrete subclass name, not the abstract base class's", () => {
    expect(new LedgerUnbalancedError("x").name).toBe("LedgerUnbalancedError");
    expect(new LedgerNegativeBalanceError("x").name).toBe("LedgerNegativeBalanceError");
    expect(new LedgerIdempotencyConflictError("x").name).toBe("LedgerIdempotencyConflictError");
  });

  it("every subclass is an instance of the shared base class, so a caller can catch broadly", () => {
    expect(new LedgerUnbalancedError("x")).toBeInstanceOf(LedgerRejectionError);
    expect(new LedgerNegativeBalanceError("x")).toBeInstanceOf(LedgerRejectionError);
    expect(new LedgerIdempotencyConflictError("x")).toBeInstanceOf(LedgerRejectionError);
  });
});
