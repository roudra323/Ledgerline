# ADR-0004 — Double-entry, enforced by the database

**Status:** Accepted

## Context

The system must be able to answer, at any instant: _what do we hold, what do we owe, and do those
two numbers agree with the outside world?_ A single-entry balance table can answer the first
question and cannot answer the third, because there is nothing to check it against.

We also need one number a reviewer can look at and immediately trust or distrust. Single-entry
balances do not produce such a number.

## Decision

`ledger_accounts` / `ledger_transactions` / `ledger_entries` (immutable, one row per debit or credit
leg) plus `ledger_account_balances` as a rebuildable projection.

**Enforcement lives in Postgres, in three layers:**

1. **Immutability** — a trigger raises on `UPDATE`/`DELETE` of `ledger_entries` and
   `ledger_transactions`; `UPDATE` and `DELETE` are additionally `REVOKE`d from the application
   role. Corrections are _reversing transactions_ with `reverses_id` set, never edits.
2. **Balance** — a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` fires at COMMIT and
   asserts, for each touched `transaction_id`, `SUM(debit) = SUM(credit)` **grouped by
   `asset_code`**. Deferred is essential: entries arrive one INSERT at a time and are only balanced
   at the end.
3. **Non-negative** — the same trigger rejects any account with `allows_negative = false` that ended
   the transaction below zero, checked against the row-locked balances projection.

The balances projection is updated in the **same transaction** as the entries, via
`UPDATE ... WHERE account_id = $1`. That row lock conveniently doubles as the serialization point
for float reservation (see failure mode C5).

## Alternatives considered

| Alternative                                         | Why it lost                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A single signed `amount` column with no `direction` | `SUM(amount) = 0` can be satisfied by a wrong-signed pair that a debit/credit split would catch. And every report you will eventually want — trial balance, T-accounts, an account statement — needs the side anyway.                                                                                                  |
| Balance computed on read (`SUM` over entries)       | O(history) per read, and worse: you lose the row-lock point that makes concurrent float reservation safe. We keep both and assert equality (invariant I2).                                                                                                                                                             |
| A mutable balances table as the source of truth     | Then the system is not event-sourced, replay proves nothing, and the entire thesis collapses.                                                                                                                                                                                                                          |
| One balanced transaction spanning USD and USDX      | Meaningless. "Sums to zero" across different units is not an invariant. The FX clearing pair is how real multi-currency ledgers do it.                                                                                                                                                                                 |
| Enforce balance in application code                 | The one place it will not run is the place it matters: a bug, a migration script, a psql session at 3am. If the constraint is not in the database, it is not a constraint.                                                                                                                                             |
| TigerBeetle as the ledger                           | Genuinely excellent at this, and the right answer at volume. Wrong here: it adds a container and moves the interesting logic out of the part of the system a reviewer will read. Also, the deferred-constraint trick is a better _demonstration_ of understanding than importing something that has already solved it. |

## Consequences

**Good.** The trial balance is a real, database-enforced invariant, exportable as a live gauge
(`ledgerline_trial_balance_residual_minor`) that must be exactly `0`. Combined with reserve coverage
(I7) this gives the demo two numbers that mean something.

**Good.** Every correction is visible as a reversing transaction, so the audit trail records both
the mistake and the fix. Nothing is ever quietly overwritten.

**Good.** Because corrections are postings rather than edits, replay determinism extends to
corrections — replaying the log reproduces the fix as well as the error.

**Bad.** Every business operation becomes several postings and many entries. A `$100` on-ramp is
four transactions and ten entries. This is more code and more thinking per feature — and it is the
price of being able to prove the system is right.

**Bad.** Deferred constraint triggers fire at COMMIT, so error messages surface at an unintuitive
place in the stack. Mitigation: `LedgerService.post()` is the _only_ writer, it validates in
application code first for a good error message, and lets the trigger be the backstop that catches
what the application missed.

**Non-negotiable rider.** This decision is only worth making if the trial-balance invariant genuinely
runs in CI. A ledger whose balances merely _should_ balance is worse than no ledger, because it makes
a claim it does not back.
