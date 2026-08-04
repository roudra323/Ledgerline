# Ledgerline Project Rules & Coding Conventions

Every action and code modification in this workspace MUST follow these strict project rules:

## 1. Golden Rules (from CLAUDE.md)

1. **Two logs, one discipline.** `raw_events` and `fiat_events` are append-only. Projections (balances, saga status) are disposable.
2. **Nothing is credited on a hint.** Receipts or optimistic local writes are hints. Sagas advance ONLY on indexed, confirmed events. Reverts drive sagas toward compensation only.
3. **Double-entry ledger balancing.** Immutable `ledger_entries`, deferred constraint trigger enforcing `Σ debits = Σ credits` per asset at COMMIT, non-negative check. `UPDATE`/`DELETE` are revoked on log tables.
4. **Money representation.** Integer minor unit of a named asset (`string` in TS, `bigint` inside helpers, `numeric(38,0)` in DB). NEVER JS `number`. Derive fee (`net = amount - fee`). Journal rounding residuals, never drop.
5. **Compensation ordering.** Refund: chain first, then fiat. Payout: burn first, then fiat. Everything reversible happens strictly before the first irreversible step.
6. **Sign and persist before broadcast.** Nonce under row lock, signed `raw_tx` committed, then `eth_sendRawTransaction`.
7. **Fail loud at boot, isolate at runtime.** Config errors crash on startup. Per-event errors dead-letter.
8. **Fail closed on compliance.** Never credit or payout on unavailable screening results.
9. **Never log secrets or high-cardinality labels.**

## 2. Working Rhythm

`make it work → make it correct (tests) → make it observable → commit.`

- Update `docs/progress.md` in the SAME commit as the work.

## 3. Code & Comment Conventions (from docs/conventions.md)

- **Readability first:** Intention-revealing names, small single-purpose functions, guard clauses first (`if (...) { throw ... }`).
- **Comments:** Comment the _why_, not the _what_.
- **No dead/commented-out code, no `console.log` noise.**
- **TypeScript:** `strict` mode non-negotiable. No `any`, no non-null `!`. Explicit return types on exported functions.
- **Formatting:** Prettier double quotes, 2-space indentation.
