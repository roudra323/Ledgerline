# ADR-0014 — Statuses are `text` + `CHECK`, not Postgres enums

**Status:** Accepted

## Context

Ledgerline has several status columns with a fixed, known set of values: `payment_intents.status`
(~14 values), `payouts.status`, `refunds.status`, `outbox_messages.status`,
`chain_transactions.status`, `fiat_events.status`. Postgres `CREATE TYPE ... AS ENUM` is the
idiomatic answer.

It is also a trap, for a reason specific to this system: **`saga_transitions` stores historical
`from_status` and `to_status` values forever.** Those rows are immutable log entries. A status value
retired in a later version of the state machine must remain readable in the rows that recorded it.

## Decision

```sql
status text NOT NULL
  CONSTRAINT payment_intents_status_check
  CHECK (status IN ('created','quoted','screening_pending', …))
```

and in `saga_transitions`, `from_status` / `to_status` are **plain `text` with no `CHECK` at all** —
they are historical facts, not current-state assertions.

TypeScript keeps the type safety with a `const` union, which is where we actually want the
exhaustiveness checking:

```ts
export const ONRAMP_STATUSES = ["created", "quoted" /* … */] as const;
export type OnrampStatus = (typeof ONRAMP_STATUSES)[number];
```

## Alternatives considered

| Alternative                                                     | Why it lost                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres `ENUM` types                                           | Adding a value is easy (`ALTER TYPE ... ADD VALUE`), but **removing or renaming one is not** — there is no `DROP VALUE`, and the workaround is create-new-type / rewrite-every-column / drop-old-type, which rewrites tables and takes locks. State machines are exactly the thing that gets refactored. And `ALTER TYPE ... ADD VALUE` could not run inside a transaction block before PG12, which is a migration-tooling papercut on top. |
| `ENUM` for current-state columns, `text` for `saga_transitions` | Half the benefit, all of the migration pain, plus an inconsistency to explain to every future reader.                                                                                                                                                                                                                                                                                                                                       |
| A `statuses` lookup table with a foreign key                    | Referential integrity for something that never varies at runtime, at the cost of a join on every read and a seed migration per new status.                                                                                                                                                                                                                                                                                                  |
| `smallint` codes with a TypeScript mapping                      | Compact and completely unreadable in `psql`. Debugging a payment at 3am should not require a decoder ring.                                                                                                                                                                                                                                                                                                                                  |
| No constraint at all, TypeScript only                           | A typo in a migration or a manual `psql` session writes a status that no code path can ever transition out of. The `CHECK` is cheap insurance.                                                                                                                                                                                                                                                                                              |

## Consequences

**Good.** Adding, renaming or retiring a status is an ordinary `ALTER TABLE ... DROP CONSTRAINT` /
`ADD CONSTRAINT`. No table rewrite, no type juggling, no lock.

**Good.** Historical transitions stay readable forever. A `saga_transitions` row from before a
refactor still says what it said.

**Good.** Statuses are human-readable in `psql`, in logs, and in Grafana labels (`to_status` is one of
the permitted low-cardinality labels).

**Bad.** No database-level guarantee that the `CHECK` list and the TypeScript union agree — they can
drift. Mitigation: a test asserts that every value in the TS `const` array is accepted by the database
and every value outside it is rejected, so drift fails CI rather than production.

**Bad.** `text` columns are marginally larger than a 4-byte enum OID. Irrelevant at this scale, and
noted only so nobody has to rediscover that it was considered.
