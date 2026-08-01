# Ledgerline — Project Rules

This file governs how work is done in this repository. It is intentionally short. Read it before
making changes.

## What this project is

A **bidirectional fiat ⇄ stablecoin payment rail**. Customers pay fiat; merchants are settled
non-custodially in a stablecoin we issue; merchants can cash out back to fiat.

Two append-only logs — `fiat_events` (off-chain) and `raw_events` (on-chain) — feed one double-entry
ledger. Every balance is a projection. See `docs/architecture.md` for the design,
`docs/failure-modes.md` for the edge-case matrix, `docs/decisions/` for the ADRs, and
`docs/build-plan.md` for the phased plan.

## Golden rules (do not violate)

1. **Two logs, one discipline.** `raw_events` and `fiat_events` are both append-only and both deduped
   by a provider-supplied identity (`UNIQUE(chain_id, tx_hash, log_index) WHERE NOT is_orphaned`;
   `UNIQUE(provider, provider_event_id)`). Never write state that cannot be re-derived from them.
   Projections — balances, saga status, `blacklist_status` — are disposable.
2. **Nothing is credited on a hint.** A receipt, a `200`, or an optimistic local write are hints.
   Sagas advance **only** on indexed, confirmed events. The one exception is a revert
   (`receipt.status = 0`), which drives a saga toward _compensation only_, never toward crediting.
3. **The ledger balances, and the database enforces it.** Immutable `ledger_entries`, a deferred
   constraint trigger asserting `Σ debits = Σ credits` **per asset** at COMMIT, and a non-negative
   check. Corrections are reversing transactions, never edits. `UPDATE`/`DELETE` are revoked on log
   tables.
4. **Money is an integer minor unit of a named asset.** `numeric(38,0)` / `string` in TS / `bigint`
   only inside helpers. **Never JS `number`.** Arithmetic may only combine the same `asset_code`.
   Cross-asset movement goes through the FX clearing pair, and rounding residuals are **journaled,
   never dropped**.
5. **Order compensations so the recoverable failure is last.** Refund: chain first, then fiat.
   Payout: burn first, then fiat. Everything reversible — screening, limits, float, simulation —
   happens strictly before the first irreversible step.
6. **Sign and persist before you broadcast.** Nonce under a row lock, signed `raw_tx` committed, then
   `eth_sendRawTransaction`. Re-broadcasting a mined tx is a success signal. Escalate only
   `MIN(nonce)` — never bump a later transaction to fill a hole.
7. **Fail loud at boot, isolate at runtime, park rather than fail.** Config/registry errors crash on
   startup. Per-event handler errors dead-letter and retry. Resource exhaustion (gas, float,
   screening unavailable) **parks** the saga in a named state instead of burning retries.
8. **Fail closed on compliance.** Never credit or pay out on an unavailable screening result. The
   cost of a wrong allow is unbounded; the cost of a delay is a support ticket.
9. **Never log secrets; never label with high-cardinality values.** The permitted Prometheus label
   set in `docs/observability.md` §1 is exhaustive. Never a merchant id, customer id, address, tx
   hash or payment id as a label — those belong in span attributes and structured logs.

## Working rhythm

> **make it work → make it correct (tests) → make it observable → commit.**

- Build **phase by phase** (Phases 0–13 in `docs/build-plan.md`). Each phase ends in a working,
  committable, demoable state. Do not start a later phase before the current one meets its exit
  criteria.
- Every new path gets a metric and, where it tells a story, a custom span before it is done.
- **Every entry in `docs/failure-modes.md` names the test that proves it.** Adding a failure mode
  without its test is adding a claim, not a design.
- A significant decision gets an ADR in `docs/decisions/` recording the **alternatives considered and
  why each lost**. ADRs are immutable once merged; supersede, never edit.

## Conventions

> **Read [`docs/conventions.md`](docs/conventions.md) before writing code — it is binding.**
> Clean, readable, standard-following code is a hard requirement here, not a nicety. Clarity beats
> cleverness. The highlights below are the summary; the doc is the full contract.

- **Readability first:** intention-revealing names, small single-purpose functions, guard clauses
  over deep nesting, comment the _why_ not the _what_, no dead/commented-out code.
- **Package manager:** pnpm (workspaces). Node 22 (`.nvmrc`).
- **Commits:** Conventional Commits, enforced by commitlint. Scopes:
  `indexer | ledger | sagas | fiat | chain | compliance | mock-psp | web | contracts | shared |
infra | docs | ci | deps | repo`. Example: `feat(ledger): enforce per-asset balance at commit`.
- **TypeScript:** strict mode. No `any` without a written reason. No non-null `!`.
- **Solidity:** `forge fmt`; custom errors over `require` strings; Checks-Effects-Interactions;
  Foundry unit **and invariant** tests.
- **Statuses are `text` + `CHECK`, not Postgres enums.**
- **Config lives in git.** Grafana dashboards, Prometheus rules and alert routes are
  provisioned-as-code — never hand-clicked in a UI.

## Honesty rules

This project models a regulated domain it is not licensed to operate in. Being precise about that is
part of the work, not a disclaimer bolted on at the end.

- **No theatre.** No "encrypted" key committed and called custody. No fake KYC vendor. No rules DSL
  with no data behind it. Build the parts that are real (signing policy, gate placement, the on-chain
  blacklist integration) and clearly label the parts that are simulated.
- **State the boundary of every claim** in the README, in the ADRs, and in code comments.

## Layout

```
apps/indexer        NestJS: ingest (both logs) · ledger · sagas · chain writer · compliance · API
apps/mock-psp       Fake payment provider with a fault-injection API
apps/web            Next.js demo UI
packages/contracts  Foundry: StableUSD + PaymentProcessor
packages/shared     ABIs, shared types, deployed addresses
infra               docker-compose + Prometheus/Grafana/OTel/Jaeger/Alertmanager + loadgen
docs                architecture · failure-modes · decisions/ · conventions · observability · runbook · build-plan
```

## The four planning documents

They answer different questions. Use the right one.

| Document                                                       | Answers                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`docs/build-plan.md`](docs/build-plan.md)                     | _What_ phases exist, exit criteria, what to cut first               |
| [`docs/learning-path.md`](docs/learning-path.md)               | _Why_ each piece exists — the concepts, in 45 blocks                |
| [`docs/implementation-guide.md`](docs/implementation-guide.md) | _What to type, in which file, in what order_ — the dependency chain |
| [`docs/progress.md`](docs/progress.md)                         | _What is done_ — the tracker                                        |

Work block by block through `implementation-guide.md`. Read the matching block in
`learning-path.md` first.

## Definition of done for a change

- [ ] Behavior implemented and covered by a test (unit / integration as appropriate).
- [ ] The block's `Verify` step in `implementation-guide.md` was actually run, not assumed.
- [ ] New failure modes documented in `docs/failure-modes.md` **with their test**.
- [ ] Metrics/spans added for any new path; labels within the permitted set.
- [ ] Money handled as integer minor units, single asset per expression.
- [ ] A significant design choice has an ADR with alternatives and why they lost.
- [ ] `pnpm lint` and `pnpm typecheck` clean.
- [ ] **[`docs/progress.md`](docs/progress.md) updated — in this same commit.** Flip the block to
      ✅, fill in date and commit, update the progress bar and "Next action", add a Log entry if a
      design decision changed. A tracker updated in a later commit drifts, and a drifted tracker is
      worse than none because it states things that aren't true.
- [ ] Conventional commit message.
