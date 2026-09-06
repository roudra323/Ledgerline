# ADR-0016 — Ledger transaction kinds are `domain.event`

**Status:** Accepted

## Context

`ledger_transactions.kind` is half of the ledger's idempotency key —
`UNIQUE(kind, cause_type, cause_id)` is what makes posting the same cause twice a database no-op — and
it is constrained by a `CHECK` list per [ADR-0014](0014-statuses-as-text.md).

The 2026-09-06 audit found the `CHECK` list and the documentation had never agreed. The migration
allowed eight snake_case values (`payment_captured`, `on_ramp_completed`, …), while the canonical
worked $100 on-ramp in [`architecture.md`](../architecture.md) §3.3, the sample in
[`implementation-guide.md`](../implementation-guide.md) Block 1.6, and
[`learning-path.md`](../learning-path.md) all used a dotted vocabulary — `onramp.capture`,
`onramp.fx`, `onramp.reserve`, `onramp.settled`.

Copying the implementation guide's own example into `post()` produced a `CHECK` violation. Worse, the
documented on-ramp is **four** postings and the `CHECK` list contained no `fx` or `reserve` kind at
all, so Part 6 could not have expressed the designed flow without a migration.

## Decision

Adopt the dotted `domain.event` vocabulary as the schema's list, in a new migration that replaces the
`CHECK`:

```
onramp.capture · onramp.fx · onramp.reserve · onramp.settled
refund.initiated · refund.chain_reversed · refund.fiat_returned
payout.requested · payout.burned · payout.settled
chargeback.received · fx.residual
```

`kind` is a machine-read discriminator, not a column name, so `docs/conventions.md` §2's snake_case
rule for **database identifiers** does not reach it — the same way `cause_type` values (`fiat_event`,
`raw_event`) are data rather than identifiers.

`pnpm docs:check` now asserts the `CHECK` list, the `TransactionKind` union and every kind literal in
`docs/` agree. This is the mitigation ADR-0014 promised for exactly this drift, generalised.

## Alternatives considered

| Alternative                                                        | Why it lost                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep snake_case, add `on_ramp_fx` and `on_ramp_reserve`            | Consistent with the rest of the schema's naming, and a smaller migration. But it invalidates the worked example in three documents — including the one artifact that teaches the whole double-entry model — to preserve a convention that governs identifiers, not values. The teaching artifact is worth more. |
| Drop the `CHECK` and let `kind` be free `text`                     | Half of an idempotency key with no bounded domain is a duplicate-credit bug waiting for a typo: `onramp.capture` and `onramp.captured` would be two different keys for one event, and the second would post a second set of entries.                                                                             |
| A `transaction_kinds` lookup table with a foreign key              | Rejected for statuses in ADR-0014 for the same reasons — a join on every read and a seed migration per new kind, to constrain something that never varies at runtime.                                                                                                                                            |
| Keep both, mapping dotted docs to snake_case storage               | Two vocabularies for one concept, plus a translation layer that must be consulted to read a `psql` dump. The audit exists because there were already two.                                                                                                                                                        |

## Consequences

**Good.** The documented on-ramp is now expressible. `architecture.md`, `implementation-guide.md`,
`learning-path.md` and `ARCHITECTURE-WALKTHROUGH.md` needed no changes — the schema moved to meet the
design, which is the direction that preserves the teaching material.

**Good.** The prefix groups by saga, so Parts 8 and 9 extend it (`refund.*`, `payout.*`) without
renegotiating the format, and `kind LIKE 'onramp.%'` is a useful query.

**Bad — and load-bearing.** Because `kind` is half the idempotency key, **this set is append-only from
here**. Renaming a kind after rows exist orphans their idempotency: the same cause would no longer
collide, and re-delivery would post duplicate entries. This migration is safe only because no
production rows exist. A future change must add a new kind and leave the old one in the `CHECK`
forever, exactly as ADR-0014 requires of retired statuses.

**Bad.** The `CHECK` list and the TypeScript union can still drift in principle. `pnpm docs:check`
turns that drift into a failed build rather than a runtime rejection.
