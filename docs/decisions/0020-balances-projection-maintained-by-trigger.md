# ADR-0020 — The balance projection is maintained by the balance trigger, not by the application

**Status:** Proposed — for review before Block 1.7 is built. Not yet implemented.

## Context

Block 1.7 makes `ledger_account_balances` a maintained projection and moves the non-negative check
onto it. What is written about it so far does not agree with itself:

- `docs/implementation-guide.md` Block 1.7 has the **application** write it: a new
  `balance.repository.ts`, called from `LedgerService.post()`, running
  `UPDATE ledger_account_balances SET balance_minor = balance_minor + $delta …`.
- ADR-0017 says 1.7 changes "what is read, not where the check lives": the **trigger** stays the
  enforcer and reads the locked projection row.

Put together, the trigger would trust a number only TypeScript maintains. Any writer that does not
go through `post()` — a migration, a `psql` session, Part 4's reorg reversal — inserts entries
without moving the balance, and the trigger then checks a stale balance and can admit an overdraft.
That is the "guarantee enforced only in TypeScript" shape `CLAUDE.md` lists as always wrong.

The table as created in `1754006400001` also leaves questions open: no row exists for any account
(a plain `UPDATE` on a missing row silently changes nothing); the sign convention is unstated;
`last_entry_id` is described as a "resume watermark" but entry ids are random UUIDs with no order,
and its foreign key costs a read on every update; the app role holds `INSERT, UPDATE` on it; and
`architecture.md` plans for `ReplayService` to truncate and rebuild it, which would blind the floor
check while it runs.

Why this block matters now: the trigger currently sums an account's whole history on every entry
into an account with a floor, under that account's lock. Measured at 50,000 prior entries it takes
about 21 ms, so every account with a floor is capped near 50 postings/second and falling as history
grows (see Measurements).

## Decision

**The deferred balance trigger maintains the projection and checks the floor against it, in one
statement per entry.** The application never writes `ledger_account_balances`.

1. **One `UPDATE` per entry, inside `assert_transaction_balances()`**, replacing both the
   `FOR NO KEY UPDATE` read of `ledger_accounts` and the history scan:

   ```sql
   UPDATE ledger_account_balances b
      SET balance_minor = b.balance_minor
                        + CASE WHEN NEW.direction = a.normal_side THEN NEW.amount_minor
                               ELSE -NEW.amount_minor END,
          updated_at = now()
     FROM ledger_accounts a
    WHERE b.account_id = NEW.account_id AND a.id = NEW.account_id
   RETURNING b.balance_minor, a.allows_negative INTO new_balance, account_allows_negative;
   -- NOT FOUND → RAISE ... USING ERRCODE = 'LL003' (no balance row: a schema bug, fail loud)
   -- NOT allows_negative AND new_balance < 0 → RAISE ... USING ERRCODE = 'LL002' (unchanged)
   ```

   The `UPDATE`'s row lock on the balance row is the serialisation the floor check needs; it
   replaces the account-row lock of ADR-0017. It is taken at COMMIT, in entry insertion order,
   which `post()` already makes account order, so the deadlock-avoiding lock order is unchanged.
   The per-transaction balance check (`LL001`) is untouched. The function stays `SECURITY DEFINER`
   with a pinned `search_path`: it now writes a table the app role may not write.

2. **Every account gets its balance row when it is created**, by an `AFTER INSERT` trigger on
   `ledger_accounts` (`SECURITY DEFINER`). This covers seeded platform accounts and merchant
   accounts created on demand by `AccountRegistryService`, and a merchant account created in a
   transaction that rolls back takes its balance row with it. The migration backfills rows for
   existing accounts from `SUM(ledger_entries)`.

3. **Sign convention: `balance_minor` is stored on the account's normal side** — positive means
   the account holds what its type says (an asset holds value, a liability is owed). This is what
   the trigger already computes, what `ledgerline_account_balance_minor` reports, and it makes the
   floor rule simply `balance_minor >= 0`.

4. **Schema changes to the table:** drop `last_entry_id` and its foreign key (an unordered id is
   not a watermark, and the update is exactly-once per entry so none is needed); add a composite
   foreign key `(account_id, asset_code) → ledger_accounts (id, asset_code)`, as `ledger_entries`
   already has (ADR-0017), so a balance row cannot claim a different asset from its account.

5. **Grants:** revoke `INSERT, UPDATE` on `ledger_account_balances` from `ledgerline_app`; it keeps
   `SELECT`. The only writers are the two trigger functions.

6. **Every account is maintained synchronously**, including those allowed to go negative
   (`1800`/`1810`/`3900`). Measured, this costs nothing: once the check is O(1), those rows are no
   more contended than the floor accounts (`2100`, `4000`) every on-ramp already locks.

7. **Rebuild is a verification, not a routine step.** Because the projection is written in the same
   transaction as each entry, it equals `SUM(ledger_entries)` by construction; invariant I2 becomes
   a check that the trigger is correct, not a correction. `ReplayService` must **not** truncate this
   table. Recovery from a detected drift is an owner-only function (`rebuild_account_balances()`)
   that takes `LOCK TABLE ledger_account_balances IN EXCLUSIVE MODE`, recomputes from entries, and
   is run deliberately, as `docs/runbook.md` will describe.

### What this means for Block 1.7's work list

- A migration implementing 1–5, and a `down()` restoring 1754006400009's function and the old
  table shape.
- `LedgerService.post()`: remove the `TODO(Block 1.7)`; no write path is added. A small **read**
  repository (`balance.repository.ts`, `SELECT` only) serves the API and metrics.
- Metric: `ledgerline_account_balance_minor{account_code, asset}` for platform accounts, now a
  cheap read (observability.md §1.3). `ledgerline_balance_projection_drift_minor` belongs to the
  I2 reconciler (Block 7.1).
- Tests: the 20-vs-10 concurrency test unchanged; projection equals recomputed sum after every
  posting (also a property in Block 1.8); app role cannot write the table; a rolled-back merchant
  account leaves no balance row; `LL003` on a missing row; `down()`/`up()` round trip. The
  lock-scope test from ADR-0019 moves its `NOWAIT` probe from the account row to the balance row.
- Docs: `scripts/docs-check.mjs` check 2b reads the lock clause from the trigger's
  `ledger_accounts` read, which no longer exists — it must learn the new shape or be retired in
  favour of the tests. `architecture.md` §2.2/§2.9, failure modes C4/C5, the implementation guide
  and the walkthrough describe the account-row lock and the replay plan, and change with it.

## Alternatives considered

| Alternative                                                                                                 | Why it lost                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The application writes the projection** (the implementation guide's `balance.repository.ts`)              | The trigger would trust a number maintained only in TypeScript. A writer bypassing `post()` desynchronises it, and the floor check then admits an overdraft from a stale balance. A convention, not a constraint.                                                                                                                                     |
| **Keep the history scan; the projection is read-only for the API**                                          | The scan is the problem: about 21 ms at 50,000 entries, under the account lock, growing forever. And two ways of computing a balance could then disagree with nothing enforcing I2.                                                                                                                                                                   |
| **Net each account once per transaction** (apply the summed delta on the first firing for that account)     | Exact rather than leg-by-leg, but "the transaction's entries" is only well defined if every entry of a header is inserted in the header's own database transaction. Enforcing that needs an `xmin`-versus-current-transaction guard that breaks under savepoints, which TypeORM uses for nested transactions. The per-entry form needs no such guard. |
| **Immediate (non-deferred) `AFTER INSERT` trigger for the update**                                          | The balance-row lock would be held from the first entry insert until COMMIT, including any time a `joinTransaction` caller spends before committing. Deferred keeps the lock to the commit itself.                                                                                                                                                    |
| **Maintain only accounts with a floor; compute the rest on read or asynchronously**                         | Measured, synchronous updates to `1800`/`3900` are no slower than without them. Skipping them would need a second mechanism with an ordered watermark, which entries do not have.                                                                                                                                                                     |
| **Append-only balance deltas with periodic compaction** (the usual hot-account pattern at very high volume) | The floor check still needs a locked, exact balance for accounts with a floor, so the hot rows remain. Far more machinery than this system's volume justifies. Revisit — by superseding this ADR — if one row's commit rate becomes the measured ceiling.                                                                                             |
| **Upsert the balance row inside the entry trigger**                                                         | Costs an `INSERT … ON CONFLICT` per entry and hides a missing row, which should be impossible and therefore loud (`LL003`).                                                                                                                                                                                                                           |
| **`SERIALIZABLE` isolation instead of row locks**                                                           | Hot rows would abort and retry under contention rather than queue, and `post()`'s idempotency re-select depends on `READ COMMITTED` (see `insertTransactionHeader`).                                                                                                                                                                                  |

## Consequences

**Good.** The floor check is O(1) per entry at any history size. The projection cannot drift from
the entries through any write path, because the only path that moves it is the one that writes an
entry. The app role can no longer set a balance. Balances become cheap to read for the API, the
metrics and the reconcilers.

**Bad — leg-by-leg strictness.** Deltas apply in insertion order and the floor is checked after
each one. A posting with several legs on one floor account (unusual in the ADR-0018 flows) could be
rejected for a negative intermediate even if its net is fine. This fails closed, never open: the
final balance is always checked by the last leg's firing, so a negative final state cannot be
admitted. `post()` can remove the case by ordering same-account legs increase-first; Block 1.8's
property test should include such postings.

**Bad.** The projection is no longer "disposable" in the sense `architecture.md` uses: it is
enforcement state, rebuilt only deliberately and under an exclusive lock. `SECURITY DEFINER`
functions grow from one to two; both must stay small and are a security review when edited.
Every account still serialises its own postings at commit; that ceiling is the commit latency of
one row, not a scan.

## Measurements

Scratch Postgres 16, the migrated schema at 1754006400009 plus a prototype of this design applied
as raw SQL (not a committed migration). 50,000 prior entries on each account involved; 3 runs each.

| Scenario                                                                        | Current (1754006400009)            | Proposed                           |
| ------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| 50 concurrent captures on floor accounts `1000`/`2100`, wall                    | 1,357–1,414 ms                     | 231–233 ms                         |
| same, p50 latency                                                               | 682–718 ms                         | 86–111 ms                          |
| 50 concurrent postings on no-floor accounts `1800`/`3900`, wall                 | 259–290 ms (measured for ADR-0019) | 230–270 ms                         |
| 20 concurrent 1-unit reserves against float of 10 in `1100`                     | 10 succeed, 10 `LL002`             | 10 succeed, 10 `LL002`             |
| Accounts whose projection differs from recomputed `SUM(entries)` after all runs | —                                  | 0                                  |
| `ledgerline_app` runs `UPDATE ledger_account_balances`                          | allowed                            | `permission denied`                |
| Merchant account inserted by `ledgerline_app`                                   | no balance row                     | balance row created by the trigger |

## Open questions for review

1. Is leg-by-leg strictness acceptable, with `post()` ordering same-account legs increase-first, or
   should the design pay for exact netting (and its savepoint problem)?
2. Should `rebuild_account_balances()` ship in Block 1.7, or with the I2 reconciler in Block 7.1?
