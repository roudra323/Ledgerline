# ADR-0003 — Typed saga aggregates, not a generic workflow engine

**Status:** Accepted

## Context

Ledgerline has three long-running, multi-step, partially-compensatable processes: the on-ramp, the
refund, and the payout. Each spans two external systems, each can fail at a dozen points, and each
has irreversible steps.

This is the textbook case for a saga. The question is how to represent one.

## Decision

**Concrete, typed aggregate tables per flow** — `payment_intents`, `refunds`, `payouts` — with real
columns, real foreign keys and real `CHECK` constraints, plus a **single shared append-only
transition log**:

```
saga_transitions
  saga_type, saga_id, from_status, to_status,
  cause_type,   -- 'fiat_event' | 'raw_event' | 'command' | 'timer' | 'operator'
  cause_id,
  is_compensating boolean,
  UNIQUE (saga_type, saga_id, cause_type, cause_id)
```

That unique key is the entire orchestration idempotency story: **applying the same cause twice is a
no-op at the database level, not the application level.**

A transition whose `from_status` does not match current state is neither an error nor silently
dropped. A transition table classifies it as `IGNORE` (a duplicate we are already past), `DEFER`
(legal later — retry with backoff) or `ILLEGAL` (dead-letter and page). This tri-state
classification is the out-of-order defence.

## Alternatives considered

| Alternative                                           | Why it lost                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Generic `saga_instances(state jsonb)`                 | Kills every database constraint — no foreign keys, no checks, no unique index on business identity. Kills TypeScript typing too: you end up with `any` or heavy casts, which `conventions.md` forbids. And it makes the _interesting_ part — the state machine — unreadable, which defeats the purpose of building this at all.      |
| Temporal, or another workflow engine                  | Genuinely the right answer in production. Wrong here: it hides exactly the machinery this project exists to demonstrate, and adds a large container to a compose file that is already big. If the value of the project is showing that you understand saga compensation, importing something that does it for you is self-defeating. |
| Event-sourced aggregates with no current-state column | Every read becomes a fold over the transition log. We keep the fold (`saga_transitions` is the truth) _and_ a `status` projection column, and assert their equality in a test. Cheap, and it makes ordinary queries ordinary.                                                                                                        |
| A `status` column with no transition log              | Loses the history that makes debugging possible, and loses the cause-keyed unique index that makes idempotency free.                                                                                                                                                                                                                 |

## Consequences

**Good.** Idempotency is structural. There is no "check if we already did this" code path to
forget — the insert either succeeds or conflicts.

**Good.** The state machines are readable as data. The compensation matrix test is literally one row
per `(saga_type, failure_injection_point)`, which makes the specification executable.

**Good.** `is_compensating` means a reorg-driven rollback is visible in history as a compensation
rather than as a mysterious backwards transition.

**Bad.** Three aggregate tables means three sets of migrations and some duplicated column shapes
(`idempotency_key`, `fx_rate_num/den`, `status`, timestamps). Accepted: the duplication is shallow
and the type safety is deep.

**Bad.** Adding a fourth flow later means real schema work rather than a config change. That is the
trade we are making on purpose — a generic engine buys flexibility we do not need and pays for it in
the exact currency we care about (constraints and types).
