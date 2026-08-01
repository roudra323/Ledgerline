# ADR-0005 — One outbox table consumed with `FOR UPDATE SKIP LOCKED`

**Status:** Accepted

## Context

Every saga step that touches the outside world has the dual-write problem: we must change our own
state _and_ cause an external effect (charge a card, broadcast a transaction, run a screening check),
and those two things cannot share a transaction.

## Decision

One table, `outbox_messages`, with a `kind` discriminator, serving both "publish a fact" and "perform
a command". The message row is inserted **in the same transaction as the state change**, which is the
entire point.

```
UNIQUE (kind, dedupe_key)
status        pending | leased | done | dead
scheduled_at, leased_until, leased_by, attempt, max_attempts
```

Claimed with `SELECT ... FOR UPDATE SKIP LOCKED` inside an `UPDATE ... WHERE id IN (...)`. Retry at
`now() + min(2^attempt, 3600)` seconds with ±20% jitter. `attempt > max_attempts` → `dead` + alert.
Lease expiry gives crash recovery for free.

**Structural requirement:** the outbox `dedupe_key` **is** the downstream idempotency key — the PSP
`Idempotency-Key`, or `chain_transactions.intent_key`. This is enforced by the `OutboxHandler`
interface requiring a `dedupeKey` from the message, not left to convention. It is what makes
at-least-once delivery safe.

## Alternatives considered

| Alternative                                            | Why it lost                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Separate `outbox` (facts) and `jobs` (commands) tables | Two pollers, two retry policies, two dead-letter paths, two dashboards — for tables with identical columns. The semantic difference is real but is fully captured by `kind`, and by the fact that _every_ handler must be idempotent regardless. |
| Redis / BullMQ                                         | Breaks the guarantee we are here for: the job must commit in the **same transaction** as the state change. With an external broker you are back to a dual write, having added a container to get there.                                          |
| `LISTEN`/`NOTIFY` as the delivery mechanism            | Not durable. A notification delivered while no listener is connected is lost with no record. Correct use: a latency optimization layered _on top of_ the polling loop.                                                                           |
| Debezium / CDC off the WAL                             | Real production answer for high volume, and enormous operational surface for a system doing tens of messages a second.                                                                                                                           |
| Direct calls with a retry decorator                    | No durability across a restart, and no visibility — you cannot put a queue depth on a dashboard if the queue is a promise chain.                                                                                                                 |

## Consequences

**Good.** Exactly one mechanism to understand, one dashboard panel (`ledgerline_outbox_depth`,
`ledgerline_outbox_oldest_pending_seconds`), one dead-letter path, one admin requeue endpoint.

**Good.** The dual-write problem is solved structurally rather than by care. There is no code path
where a state change commits without its side effect being queued.

**Good.** Postgres handles this comfortably at our volume — a `SKIP LOCKED` queue runs on the order
of thousands of jobs per second on a single modest instance, which is orders of magnitude more than
we need.

**Bad.** Polling means baseline database load even when idle, and a latency floor equal to the poll
interval. Mitigated by `NOTIFY`, bounded by keeping the poll interval short and the claim query
indexed (`(status, scheduled_at) WHERE status IN ('pending','leased')`).

**Bad.** At-least-once, never exactly-once. Every handler _must_ be idempotent, and a handler author
who forgets will not find out until production. Mitigation: the interface makes `dedupeKey`
mandatory, and the contract test suite for each handler includes "invoke twice, assert one effect."
