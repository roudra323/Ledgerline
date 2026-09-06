# ADR-0017 — The non-negative invariant is enforced by the trigger, under a row lock

**Status:** Accepted

## Context

[`architecture.md`](../architecture.md) §2.2 and [ADR-0004](0004-double-entry-ledger.md) describe the
ledger's deferred constraint trigger as enforcing three things: immutability, `Σ debits = Σ credits`
per asset, and **non-negative balances** on accounts with `allows_negative = false`. Migration
`1754006400004` added the third after the gap was found.

The 2026-09-06 audit found that implementation was not concurrency-safe. It derives the balance with
a bare `SUM` over `ledger_entries`:

```sql
SELECT SUM(...) INTO account_balance FROM ledger_entries WHERE account_id = NEW.account_id;
```

The trigger is `DEFERRABLE INITIALLY DEFERRED`, so it runs at COMMIT — but under `READ COMMITTED`
each statement takes a fresh snapshot that still excludes *uncommitted* rows. Two transactions that
reach their commit-time trigger concurrently therefore each read a balance excluding the other's
entries. Both pass. The account goes negative.

This is textbook write-skew, and it is precisely Part 1's exit criterion:

> 20 concurrent payouts against float for 10 → **exactly 10 succeed**.

As written, that test could yield 11.

## Decision

Keep the invariant in the trigger — it stays a database object, per golden rule 3 and
[`conventions.md`](../conventions.md) §9 — and make it serialise by locking the account row it
already reads:

```sql
SELECT normal_side, allows_negative INTO ...
  FROM ledger_accounts WHERE id = NEW.account_id
  FOR UPDATE;
```

Concurrent commits touching the same account now queue behind each other, so the second one's balance
read includes the first one's committed entries. The same migration also filters the balance sum by
`asset_code` and adds the composite foreign key
`ledger_entries (account_id, asset_code) → ledger_accounts (id, asset_code)`, so the "accounts are
per-asset" assumption the sum relied on is now enforced rather than assumed.

The function becomes `SECURITY DEFINER`, with `search_path` pinned to `pg_catalog, public`.
`SELECT ... FOR UPDATE` requires **UPDATE privilege** on the table, and `ledgerline_app` deliberately
has only `SELECT` and `INSERT` on `ledger_accounts` — the app must never rewrite an account. Running
the trigger as its owner keeps the lock available without weakening that grant. Pinning `search_path`
is mandatory for any `SECURITY DEFINER` function: an unqualified name inside one is otherwise
resolvable against a schema the caller controls.

**Block 1.7 will change what is read, not where the check lives.** Once
`ledger_account_balances` is a maintained projection, the trigger reads that locked row instead of
re-deriving from history. That removes the `O(entries per account)` scan this version performs on
every insert. A `TODO(Block 1.7)` marks the spot.

## Alternatives considered

| Alternative                                                       | Why it lost                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move the check into `LedgerService.post()`, inside Block 1.7's lock | Faster, and the lock would be explicit in application code. But it makes the invariant a *convention*: a migration, a psql session, or Part 4's reorg reversal writing entries directly would bypass it entirely. Golden rule 3 says the database enforces this, and the whole point of a ledger is that a second writer cannot lie. |
| Run the posting transaction at `SERIALIZABLE`                     | Correct, and it would catch this class of bug generically. But it pushes serialisation failures onto every caller, requires a retry loop at each of them, and imposes the cost on transactions that touch no constrained account. A targeted row lock is the smaller hammer.                                                          |
| `SELECT ... FOR UPDATE` on the `ledger_entries` rows instead       | You cannot lock rows that do not exist yet, which is the entire problem — the conflicting transaction's entries are the ones you need to see. Locking a single, always-present parent row is the standard answer.                                                                                                                    |
| Do Block 1.7 now and fix it properly in one step                  | The right end state, but it merges a new feature block into a fix pass, against this project's own one-block-per-session rule, and would leave the fix record unreadable. The lock closes the correctness hole today; 1.7 removes the scan.                                                                                          |
| Accept it — concurrency is unlikely in a demo                     | The exit criterion for Part 1 is a concurrency test. Building the system whose thesis is "the database makes this impossible" and then hoping is the exact failure this project exists to avoid.                                                                                                                                    |

## Consequences

**Good.** The non-negative guarantee now holds under concurrent commits, and it holds for *any*
writer, not just `LedgerService.post()`.

**Good.** The composite foreign key closes a second, independent hole: an entry can no longer name one
asset while pointing at an account configured for another, which would have made any ungrouped
`SUM(amount_minor)` produce a plausible-looking, wrong number.

**Bad — and deliberate.** Locking inside a deferred trigger means two transactions touching the same
pair of accounts in opposite orders can **deadlock**. Postgres detects it and aborts one, which is a
rollback — never a wrong balance. It fails closed, which is the correct direction for money, but it is
a new way for a posting to fail and callers must be prepared to retry. Documented here rather than
discovered at 3am.

**Bad.** `SECURITY DEFINER` means this function runs with the table owner's privileges. That is the
narrowest way to get the lock, but it is a privilege boundary and it must stay tiny and auditable —
it reads two tables and raises. Any future edit to it is a privilege-escalation review, not a routine
change.

**Bad.** The full-history `SUM` remains until Block 1.7, so the check's cost grows with the ledger.
Acceptable at current scale, tracked by a `TODO(Block 1.7)`, and the reason 1.7 is the next block.
