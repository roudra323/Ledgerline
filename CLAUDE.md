# ChainStake — Project Rules

This file governs how work is done in this repository. It is intentionally short. Read it before
making changes.

## What this project is

An **event-sourced blockchain staking indexer**: all state is derived from on-chain events. The
chain is the source of truth; the database is a rebuildable projection. See `docs/architecture.md`
for the design and `docs/build-plan.md` for the full phased plan.

## Golden rules (do not violate)

1. **The chain is the source of truth.** Never write state that cannot be re-derived from
   `raw_events`. Projections (`staking_records`, `user_balances`, `contract_status`) are disposable.
2. **Idempotent ingestion.** Every raw event is keyed by `UNIQUE(chain_id, tx_hash, log_index)`.
   Inserts use `ON CONFLICT DO NOTHING`. Re-applying any event twice must yield identical state.
3. **One transaction per chunk.** Cursor advance + raw-event inserts commit together, or not at all.
   A crash mid-chunk must be safe to restart from the persisted cursor.
4. **Order-independent projections.** Aggregate-recompute balances; never assume event arrival order
   beyond `(block_number, log_index)` sort within a chunk.
5. **Fail loud at boot, isolate at runtime.** Registry/config errors crash on startup. Per-event
   handler errors are caught, marked `failed`, and retried — one bad event never stalls the loop.
6. **Never log secrets or high-cardinality labels.** Metric labels are limited to `sync_key`,
   `event_name`, `provider`, `contract`, `route`, etc. Never user addresses or tx hashes as labels
   (they belong in span attributes and structured logs, not Prometheus label sets).

## Working rhythm (per the build plan)

> **make it work → make it correct (tests) → make it observable → commit.**

- Build **phase by phase** (Phases 0–8 in `docs/build-plan.md`). Each phase ends in a
  working, committable state. Do not start a later phase before the current one meets its exit
  criteria.
- Every new indexer path gets a metric and, where it tells a story, a custom span before it is
  considered done.

## Conventions

> **Read [`docs/conventions.md`](docs/conventions.md) before writing code — it is binding.**
> Clean, readable, standard-following code is a hard requirement here, not a nicety. Clarity beats
> cleverness. The highlights below are the summary; the doc is the full contract.

- **Readability first:** intention-revealing names, small single-purpose functions, guard clauses
  over deep nesting, comment the _why_ not the _what_, no dead/commented-out code.
- **Package manager:** pnpm (workspaces). Node 22 (`.nvmrc`).
- **Commits:** Conventional Commits, enforced by commitlint. Scopes:
  `indexer | web | contracts | shared | infra | docs | ci | deps | repo`.
  Example: `feat(indexer): add adaptive chunk sizing`.
- **TypeScript:** strict mode (`tsconfig.base.json`). No `any` without a written reason.
- **Solidity:** formatted with `forge fmt`; tested with Foundry incl. invariant tests.
- **Naming:** kebab-case for files/dirs, PascalCase for Nest classes and Solidity contracts,
  snake_case for database columns.
- **Config lives in git.** Grafana dashboards, Prometheus rules, and alert routes are
  provisioned-as-code — never hand-clicked in a UI.

## Layout

```
apps/indexer   NestJS: indexer engine + read API + admin (replay/catch-up)
apps/web       Next.js demo UI
packages/contracts  Foundry: StakingVault + MockToken
packages/shared     ABIs, shared types, deployed addresses
infra          docker-compose + Prometheus/Grafana/OTel/Jaeger/Alertmanager + loadgen
docs           conventions, architecture, observability, runbook, build-plan
```

## Definition of done for a change

- [ ] Behavior implemented and covered by a test (unit / integration as appropriate).
- [ ] Metrics/spans added for any new indexer or API path.
- [ ] `pnpm lint` and `pnpm typecheck` clean.
- [ ] Conventional commit message.
