# ADR-0019 — Ledger rejections are typed, and the balance trigger locks only accounts with a floor

**Status:** Accepted

## Context

A review of the ledger after the 2026-09-06 audit found three gaps between what the ledger does
and what its callers — the Part 5–6 sagas — will need from it.

1. **The balance trigger did work it could never use.** `assert_transaction_balances()`
   (1754006400007) locked every touched account `FOR NO KEY UPDATE` and summed its full history,
   then consulted `allows_negative` only to decide whether to raise. For `1800`/`1810 fx_clearing`
   and `3900 rounding_residual` the check cannot fail, yet every on-ramp's `onramp.fx` posting
   touches `1800` and `1810`, so every on-ramp serialised behind those two row locks.
2. **The trigger's two rejections were indistinguishable.** Both used the default SQLSTATE `P0001`.
   Golden rule 7 requires a saga to **park** on an exhausted float and to dead-letter a malformed
   posting; with one error code, the only discriminator was the message text.
3. **An idempotent replay was trusted blindly.** On `ON CONFLICT (kind, cause_type, cause_id)`,
   `post()` returned `alreadyPosted: true` without comparing legs, so a replay carrying different
   amounts was acknowledged and discarded (`ARCHITECTURE-WALKTHROUGH.md` §14, open item 8).

## Decision

**Migration 1754006400009** replaces the trigger function:

- The locking read carries the rule in its predicate —
  `WHERE id = NEW.account_id AND NOT allows_negative FOR NO KEY UPDATE`. An account allowed to go
  negative returns no row, is never locked, and skips the history scan. Under `READ COMMITTED`,
  Postgres re-evaluates the predicate on the locked row version, so the decision and the lock come
  from one read. Accounts with a floor keep exactly ADR-0017's lock and check.
- The unbalanced rejection raises SQLSTATE **`LL001`**; the non-negative rejection raises
  **`LL002`**. Class `LL` is not used by Postgres. Message texts are unchanged.

**TypeScript** (`apps/indexer/src/ledger/ledger-errors.ts`):

| Class                            | Raised when                                         | A saga should  |
| -------------------------------- | --------------------------------------------------- | -------------- |
| `LedgerUnbalancedError`          | TS pre-check, or `LL001` at COMMIT                  | dead-letter    |
| `LedgerNegativeBalanceError`     | `LL002` at COMMIT                                   | park, on float |
| `LedgerIdempotencyConflictError` | a replayed cause's legs differ from the stored legs | page           |

`toLedgerError()` maps a pg or TypeORM error by SQLSTATE. `post()` applies it on its own
transaction; a caller using `joinTransaction` applies it to its own COMMIT, since that is where the
deferred trigger fires. Every rejection `post()` observes increments
`ledgerline_ledger_postings_rejected_total{kind, reason_class}`.

**Replay comparison.** On the already-posted path `post()` compares the requested legs with the
stored entries as a multiset of (account code, merchant, asset, direction, amount), in SQL
(`jsonb_to_recordset` and `EXCEPT ALL` in both directions) so the database's own `uuid` and
`numeric` casts normalise both sides. `memo` and `postedAt` are excluded: a live redelivery
legitimately carries a different wall-clock time.

## Alternatives considered

| Alternative                                                             | Why it lost                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read `allows_negative` unlocked first, then lock only if false          | Two reads of one row; the second must re-check anyway. The predicate on the locking read is one statement with the same effect.                                                       |
| Keep locking every account, fix contention in Block 1.7                 | 1.7 moves the read to the projection row but would inherit the same lock-everything shape. Scoping the lock is independent of where the balance is read, so it belongs here first.    |
| Match on message text in TypeScript                                     | A convention, not a contract: rewording a message silently turns a park into a dead-letter.                                                                                           |
| `RAISE ... USING ERRCODE` with standard codes (`23514 check_violation`) | A real `CHECK` violation elsewhere would be misread as a ledger floor breach. A private class cannot collide.                                                                         |
| Store a hash of the legs on `ledger_transactions` and compare hashes    | Needs a column that is `NULL` for every existing row, so existing postings could not be verified; the hash's canonical form would be a second, TypeScript-owned definition of "same". |
| Compare legs in TypeScript after resolving account codes                | Resolving a merchant leg can create an account, a side effect on what should be a read; and `uuid`/`numeric` normalisation would be reimplemented by hand.                            |

## Consequences

**Good.** Postings touching only no-floor accounts no longer contend on the trigger's row lock, and
no longer pay for a history scan whose result is discarded. A saga can route rejections by class.
A replay that disagrees with history is now loud.

**Bad.** Accounts with a floor still pay the full-history scan until Block 1.7. Rejections at a
joined caller's COMMIT are not counted by `post()`; each such caller must translate and count them.
Changing `allows_negative` on a live account is now also a change to which postings serialise — an
operator flipping it should expect that.
