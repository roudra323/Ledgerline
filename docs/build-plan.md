# ChainStake — Production-Grade Event-Driven Staking Indexer

## Complete A-to-Z Build Plan (Portfolio / Resume Project)

**What you're building:** A staking platform whose backend derives all state from smart-contract events — a self-hosted, event-sourced blockchain indexer (NestJS + viem + PostgreSQL) with a full production observability stack: Prometheus + Grafana (metrics/APM), OpenTelemetry + Jaeger (distributed tracing), structured logging, alerting, CI/CD, and a demo frontend.

**Why this impresses recruiters:** It's not a CRUD app. It demonstrates distributed-systems thinking (idempotency, event sourcing, reorg handling, crash recovery), real DevOps/SRE skills (metrics, tracing, dashboards, alerts, Docker, CI), and blockchain depth (Solidity, Foundry, viem) — all in one coherent, runnable system with a one-command demo.

**Suggested name:** `chainstake` (repo: `chainstake-indexer`). Pick your own — a memorable name matters on a resume.

---

# PART 1 — PROJECT DEFINITION

## 1.1 Functional scope (keep it tight — depth over breadth)

**Smart contract (Solidity + Foundry):**

- `StakingVault.sol`: `stake()`, `withdraw()`, `claimRewards()`, owner `pause()/unpause()`, simple linear reward accrual.
- Events: `Staked(address indexed user, uint256 amount, uint256 totalStaked)`, `Withdrawn(...)`, `RewardsClaimed(...)`, `Paused/Unpaused`. Events carry full context (amount + resulting total) — this is a deliberate, explainable design choice (self-contained events → deterministic handlers).
- An ERC20 `MockToken` for staking.

**Indexer service (NestJS):** the architecture from the design doc —

- Single parameterized indexing loop (backfill = live = catch-up), adaptive chunking, per-contract cursors in `sync_state`.
- Append-only `raw_events` with `UNIQUE(chain_id, tx_hash, log_index)`.
- Handler registry via `@OnChainEvent` decorator + NestJS discovery.
- Projections: `staking_records`, `user_balances` (aggregate-recomputed, order-independent), `contract_status`.
- Reorg guard (confirmation depth + hash continuity + rollback/orphaning).
- Failure isolation: per-event try/catch, `failed` status, retry job, dead-letter alerting.
- Replay service: rebuild projections from raw_events (expose as an admin CLI/endpoint — great demo).
- Reconciliation audit job: on-chain `totalStaked()` vs indexed sum (cron, emits a metric).

**Read API (same NestJS app, separate module):**

- `GET /users/:address/balance`, `GET /users/:address/history`, `GET /stats` (TVL, stakers count), `GET /health/indexer` (lag, cursor positions).

**Demo frontend (small — Next.js or even a single page):** connect wallet (viem/wagmi), stake/withdraw buttons, live balance + history from _your API_, "indexer lag" badge. It exists to make the demo visceral, not to show off React.

**Load generator (small script):** fires randomized stake/withdraw txs against Anvil so dashboards have living data during demos. Underrated — this is what makes your Grafana screenshots look real.

## 1.2 Explicit non-goals (write these in the README — scoping is a senior signal)

Mainnet deployment, real funds, mempool tracking, multi-instance ingest scaling, token price feeds.

## 1.3 Final deliverables checklist

- [ ] Monorepo with contracts + indexer + frontend + infra
- [ ] `docker compose up` brings up **everything** (Anvil, Postgres, indexer, Prometheus, Grafana, Jaeger, OTel Collector, frontend, load-gen)
- [ ] 2 provisioned Grafana dashboards (auto-loaded, not hand-made clicking)
- [ ] Alert rules firing to a demo channel
- [ ] CI: lint, unit, integration (fork tests), contract tests, Docker build
- [ ] README with architecture diagram, screenshots, 5-minute demo script
- [ ] Short demo video/GIF (recruiters rarely run your code; they _will_ watch 90 seconds)

---

# PART 2 — REPO & STACK

## 2.1 Monorepo layout (pnpm workspaces)

```
chainstake/
├── apps/
│   ├── indexer/                  # NestJS: indexer + API + admin
│   │   ├── src/
│   │   │   ├── blockchain/       # core/, events/, entities/ (design doc §2.1)
│   │   │   ├── api/              # read endpoints
│   │   │   ├── admin/            # replay, catch-up triggers (guarded)
│   │   │   ├── observability/    # otel.ts, metrics.service.ts, logger
│   │   │   └── main.ts
│   │   └── test/                 # unit + integration
│   └── web/                      # Next.js demo UI
├── packages/
│   ├── contracts/                # Foundry project
│   │   ├── src/StakingVault.sol, MockToken.sol
│   │   ├── test/                 # .t.sol tests incl. invariant tests
│   │   └── script/Deploy.s.sol
│   └── shared/                   # ABIs (wagmi/viem codegen), types, addresses
├── infra/
│   ├── docker-compose.yml
│   ├── prometheus/prometheus.yml, alerts.yml
│   ├── grafana/provisioning/{datasources,dashboards}/ + dashboards/*.json
│   ├── otel/otel-collector-config.yaml
│   └── loadgen/                  # tx firehose script
├── .github/workflows/ci.yml
├── docs/
│   ├── architecture.md           # the design doc you already have
│   ├── observability.md
│   └── runbook.md                # "what to do when X alert fires" — huge senior signal
└── README.md
```

## 2.2 Stack decisions (with the one-line justification you'll say in interviews)

| Choice                                        | Why (interview answer)                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| NestJS + TypeScript                           | DI makes the handler-registry pattern natural; matches my production experience |
| viem                                          | Typed ABI inference, first-class `getLogs`/transport fallback                   |
| PostgreSQL + TypeORM (or Drizzle)             | Transactions + unique constraints are the idempotency backbone; jsonb for args  |
| Foundry + Anvil                               | Fast Solidity tests; Anvil gives deterministic local chain + reorg simulation   |
| prom-client via `@willsoto/nestjs-prometheus` | Standard pull-based metrics, zero vendor lock-in                                |
| OpenTelemetry SDK → OTel Collector → Jaeger   | Vendor-neutral tracing; collector shows I understand real telemetry pipelines   |
| Grafana provisioning-as-code                  | Dashboards in git = reproducible; clicking in UI = not production               |
| pino (nestjs-pino)                            | Structured JSON logs with trace_id injection → logs↔traces correlation          |

---

# PART 3 — BUILD PHASES (A → Z)

Estimated total: **6–8 weeks part-time.** Each phase ends in a working, committable state — commit history that shows incremental professional progress is itself a portfolio artifact.

## Phase 0 — Foundations (2–3 days)

1. Init monorepo, pnpm workspaces, ESLint/Prettier, commitlint (conventional commits), husky.
2. Foundry project: `StakingVault` + `MockToken` + tests:
   - Unit tests per function; **invariant test**: `sum(user stakes) == token.balanceOf(vault)` under a fuzzed action sequence. (Invariant testing is a strong resume phrase.)
3. `Deploy.s.sol` + a `make chain` target: run Anvil, deploy, write addresses to `packages/shared/addresses.json`.
4. ABI codegen into `packages/shared` (`@wagmi/cli` or a small script).

**Exit criteria:** `forge test` green; one command gives you a local chain with contracts deployed.

## Phase 1 — Skeleton indexer, happy path (1 week)

1. NestJS app, TypeORM entities + migrations: `raw_events`, `sync_state`, `indexer_failures` (schemas from design doc §3).
2. `ChainClient` (viem public client, single transport for now), `LogFetcher` (fixed chunk size), `SyncStateService`.
3. `IndexerService.runChunk()` with the non-negotiables from day one: sort by `(block, logIndex)`; cursor-advance + inserts in **one transaction**; `ON CONFLICT DO NOTHING`; empty ranges advance cursor; `head - confirmations` cap.
4. `@OnChainEvent` decorator + `EventRegistry` (DiscoveryService scan, boot-time validations: dup handlers, unknown events → crash loudly).
5. `StakedHandler`, `WithdrawnHandler` → `staking_records` (provenance-keyed upserts) + `user_balances` recomputed by aggregation.
6. Scheduler (`@nestjs/schedule`, 5s tick) with per-key in-process mutex.
7. Manual test: run chain, stake via `cast`, watch rows appear.

**Exit criteria:** stake/withdraw on Anvil → rows in projections within seconds; restart mid-run → no dupes, no gaps.

## Phase 2 — Production hardening (1–1.5 weeks)

1. **Adaptive chunking:** halve on too-large errors, floor 1, multiplicative recovery.
2. **Reorg guard:** hash continuity + rollback (orphan raw_events, rewind cursor, replay affected range). Test with Anvil: `anvil_snapshot`/`anvil_revert` + re-mine to force divergent hashes.
3. **Failure isolation:** per-event catch → `failed` + error; retry job (cron, capped attempts); events for a user re-run in order on retry.
4. **ReplayService** + admin endpoint/CLI: `POST /admin/replay {projections:[...]}` — pause dispatch, truncate, stream raw_events ordered, resume. (Practice narrating this; it's your best demo moment.)
5. **Catch-up jobs:** generalized `sync_state` rows (`kind='catchup'`, frozen `target_block`), auto-created from registry diff on boot. Demo: comment out `RewardsClaimed` handler + its event from the fetch set, run a while, re-enable → watch auto catch-up + replay.
6. **RPC failover:** viem `fallback([anvil, anvil2])` — in demo you can kill one Anvil container and show the indexer shrugging.
7. **Reconciliation audit cron:** `eth_call totalStaked()` vs `SUM(user_balances)` → emit `chainstake_reconciliation_drift` metric (should be 0).

**Exit criteria:** kill -9 the indexer mid-chunk, restart → consistent; simulated reorg → orphaned + rebuilt; replay rebuilds identical projections (snapshot-compared in a test).

## Phase 3 — Observability: metrics + APM (1 week)

### 3.1 Prometheus metrics (the exact instrument list)

Naming: `chainstake_` prefix, standard units, labels kept low-cardinality (`sync_key`, `event_name`, `provider` — **never** user addresses or tx hashes as labels).

**Indexer health (the star dashboard):**

```
chainstake_indexer_lag_blocks{sync_key}            gauge   # chainHead - cursor
chainstake_indexer_lag_seconds{sync_key}           gauge
chainstake_chunk_size{sync_key}                    gauge   # adaptive value = provider health proxy
chainstake_chunks_processed_total{sync_key,result} counter # result=ok|rpc_error|db_error
chainstake_chunk_duration_seconds{sync_key,phase}  histogram # phase=fetch|decode|persist|dispatch
chainstake_events_ingested_total{contract,event_name} counter
chainstake_events_failed_total{event_name}         counter
chainstake_events_retried_total{event_name,result} counter
chainstake_reorg_rollbacks_total{sync_key}         counter  # each one is an incident story
chainstake_reorg_depth_blocks                      histogram
chainstake_reconciliation_drift_wei                gauge    # THE trust metric
chainstake_catchup_remaining_blocks{sync_key}      gauge
```

**RPC layer:**

```
chainstake_rpc_requests_total{provider,method,result}  counter
chainstake_rpc_request_duration_seconds{provider,method} histogram
chainstake_rpc_provider_healthy{provider}              gauge (0/1)
```

**API (APM proper):** RED method — `http_requests_total{route,method,status}`, `http_request_duration_seconds{route}` (histogram → p50/p95/p99), in-flight gauge. Use an interceptor so every route is covered automatically.

**Runtime:** default prom-client metrics (event loop lag, heap, GC) + `pg` pool gauges. Postgres itself via `postgres-exporter` container.

### 3.2 Grafana — two provisioned dashboards (JSON in git)

**Dashboard 1 — "Indexer Operations":**

- Row 1: lag (blocks & seconds) per sync_key with thresholds; chain head vs cursor as two series (the "chasing line" during backfill is visually great).
- Row 2: events/min stacked by event_name; chunk duration heatmap by phase; adaptive chunk size over time.
- Row 3: failed events, retry outcomes, reorg counter; reconciliation drift stat panel (big green **0**).
- Row 4: RPC p95 latency + error rate per provider.

**Dashboard 2 — "API & Runtime (APM)":**

- RED per route (rate, error %, p50/p95/p99), Apdex-style stat.
- Event loop lag, heap, GC pauses, DB pool saturation.
- Panel links: click a latency spike → jump to Jaeger traces in that time window (dashboard-to-trace linking = real APM workflow).

### 3.3 Alert rules (`infra/prometheus/alerts.yml`)

```
IndexerLagHigh:        lag_seconds > 120 for 5m         (warning)
IndexerStalled:        increase(chunks_processed_total[10m]) == 0  (critical)
EventProcessingFailed: increase(events_failed_total[5m]) > 0 on funds events (critical)
ReconciliationDrift:   drift_wei != 0 for 10m           (critical — page)
RpcProviderDown:       provider_healthy == 0 for 3m     (warning)
ApiP95High:            p95 > 500ms for 10m              (warning)
```

Route via Alertmanager to a Discord/Slack webhook. In the demo: stop Anvil → watch `IndexerStalled` fire → restart → auto-resolve. Screenshot that for the README.

**Exit criteria:** `/metrics` scraped; both dashboards auto-provision on `compose up`; at least one alert demonstrably fires and resolves.

## Phase 4 — Observability: tracing + logs (0.5–1 week)

### 4.1 OpenTelemetry setup

- `otel.ts` bootstrapped **before Nest** (NodeSDK + auto-instrumentations: http, express/nest, pg, undici). Exporter: OTLP → **OTel Collector** → Jaeger. (Collector in the middle, not direct-to-Jaeger: batching, retry, and the ability to fan out to Tempo/vendor later — say exactly this in interviews.)
- Resource attrs: `service.name=chainstake-indexer`, `service.version` from git SHA, `deployment.environment`.

### 4.2 Custom spans that tell the story (auto-instrumentation alone is generic; these are yours)

```
indexer.chunk (root, per runChunk)          attrs: sync_key, from_block, to_block, log_count
 ├── rpc.get_logs                            attrs: provider, chunk_size, retry_count
 ├── reorg.continuity_check
 ├── db.persist_raw_events                   attrs: inserted, deduped
 └── dispatch
      ├── handler.Staked (per event)         attrs: tx_hash, log_index, block_number
      └── handler.Withdrawn ...
replay.rebuild (root)                        attrs: projections, event_count
api.* (auto)  → spans through pg queries
```

Record exceptions on spans (`span.recordException`) and set error status — failed handler events become red spans in Jaeger, findable by `tx_hash` attribute. Searching Jaeger by tx_hash to debug one event's journey is a killer demo.

### 4.3 Logs

- nestjs-pino, JSON output; inject `trace_id`/`span_id` into every log line (pino OTel mixin). Now a Grafana panel → Jaeger trace → grep trace_id in logs is a complete correlation loop across all three signals.
- Optional stretch: add Loki + promtail to compose and link logs in Grafana too (nice, not required).

**Exit criteria:** one stake tx produces a connected trace: chunk → getLogs → persist → handler; API request traces show pg spans; logs carry trace_ids.

## Phase 5 — Frontend + load generator (0.5 week)

1. Next.js page: wagmi connect, stake/withdraw forms, balance + history table polling your API, "data as of block N / lag Xs" badge fed by `/health/indexer` (surfacing eventual consistency honestly — mention this).
2. `infra/loadgen`: script with N funded Anvil accounts firing weighted random stake/withdraw every 1–3s. Runs as a compose service with a profile (`--profile demo`).

## Phase 6 — Docker Compose: the one-command demo (0.5 week)

```yaml
services:
  anvil: # foundry image, fixed mnemonic, --block-time 2
  deployer: # runs forge script once, writes addresses to a shared volume, exits
  postgres:
  indexer: # depends_on deployer completed; multi-stage Dockerfile, non-root user
  web:
  loadgen: # profile: demo
  prometheus:
  grafana: # provisioned datasources + dashboards, anonymous viewer enabled
  otel-collector:
  jaeger: # all-in-one
  alertmanager:
  postgres-exporter:
```

Details that read as production-quality: healthchecks + `depends_on: condition: service_healthy` ordering; multi-stage Dockerfile (~150MB final, non-root); `.env.example`; `make demo` = `docker compose --profile demo up`.

**Exit criteria:** fresh clone → `make demo` → within ~2 minutes: UI live, Grafana graphs moving, Jaeger traces flowing. This exact experience is what you give recruiters.

## Phase 7 — Testing & CI (0.5–1 week)

1. **Unit:** handlers (pure), chunker (mock too-large errors), registry validations.
2. **Idempotency test:** every fixture applied twice → identical state.
3. **Replay golden test:** ingest fixture stream → snapshot projections → truncate → replay → deep-equal.
4. **Integration (testcontainers or compose-in-CI):** Anvil + Postgres; real txs → assert projections; kill/restart indexer mid-stream → assert consistency; snapshot/revert reorg → assert orphaning.
5. **CI (`ci.yml`):** jobs = lint, forge test, unit, integration, docker build (buildx, cached), plus badge in README. Optional: `slither` static analysis on contracts (one more resume line).

## Phase 8 — Docs, polish, resume packaging (0.5 week)

1. **README** (this sells the project — spend real time): banner architecture diagram (excalidraw/mermaid), 3–4 screenshots (Grafana lag panel during backfill, Jaeger trace of a chunk, alert firing in Discord, UI), quickstart, "Design highlights" section of 6 bullets (idempotency key, single-loop design, replay, reorg handling, adaptive chunking, reconciliation), link to `docs/architecture.md`.
2. **docs/runbook.md:** per alert — meaning, likely causes, resolution steps. Recruiters who've done on-call _notice_ this.
3. **90-second demo GIF/video:** start compose → stake in UI → row appears → Grafana moving → open a Jaeger trace → trigger replay → dashboards recover.
4. **Optional deploy** (free/cheap): run compose on a small VPS or Railway with a public Grafana (anonymous read-only) + public testnet (Sepolia) contract instead of Anvil. A live Grafana link on a resume is rare and memorable. If cost is a concern, the video suffices.

---

# PART 4 — RESUME & INTERVIEW PACKAGING

## 4.1 Resume bullets (pick 3–4, quantify with your real numbers)

- Built **ChainStake**, an event-sourced blockchain indexing platform (NestJS, viem, PostgreSQL) that derives all staking state from on-chain events with exactly-once processing via idempotent ingestion (`UNIQUE(chain_id, tx_hash, log_index)`), crash-safe transactional cursors, and chain-reorg detection with automatic rollback and projection rebuild.
- Designed a single parameterized indexing engine unifying historical backfill, live polling, and per-event catch-up jobs; adaptive `getLogs` chunking with RPC provider failover sustained **X events/min** with **<Ys** end-to-end lag on local benchmarks.
- Implemented full observability: **20+ Prometheus metrics**, 2 provisioned Grafana dashboards, Alertmanager rules (lag, stall, reconciliation drift), and OpenTelemetry distributed tracing (OTel Collector → Jaeger) with custom spans per chunk/handler and trace-correlated structured logs.
- Guaranteed data integrity with an automated on-chain reconciliation audit (`totalStaked()` vs indexed aggregates), replay-based projection rebuilds, and a test suite covering idempotency, replay determinism, and simulated reorgs (Foundry invariant tests + Anvil fork integration tests in CI).

## 4.2 Interview stories to rehearse (STAR-ready)

1. **"Why not just have the frontend POST the tx hash?"** → trust boundary, chain as source of truth, what breaks otherwise.
2. **"Walk me through what happens if the process dies mid-chunk."** → single transaction invariant, restart from cursor, unique-key dedupe.
3. **"How do you handle a reorg?"** → depth + continuity check + orphan/rewind/replay; why projections being derived makes this mechanical.
4. **"A bug shipped and 3 weeks of balances are wrong — now what?"** → fix handler, replay from raw_events, minutes, no RPC. (This is the event-sourcing payoff story.)
5. **"Why an OTel Collector instead of exporting straight to Jaeger?"** → decoupling, batching/retry, vendor portability.
6. **"What's the metric you'd page on?"** → reconciliation drift ≠ 0: the only metric that proves the DB matches the chain.

## 4.3 Where it fits your profile

This project is a natural extension of your Kazentic indexer work into a fully self-owned, end-to-end system — and the raw_events/replay design connects directly to your StreamPay thesis interests (deterministic state from ordered on-chain facts). You can honestly present it as "the production architecture I use at work, rebuilt from scratch with the observability layer I wanted to go deeper on."

---

# PART 5 — RISK & SCOPE CONTROL

| Risk                                                             | Mitigation                                                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Scope creep (frontend rabbit hole, extra features)               | Frontend is deliberately minimal; non-goals in README; ship Phase-by-Phase                                       |
| Observability configured but _empty_ (no data → dead dashboards) | Load generator is a first-class deliverable, not an afterthought                                                 |
| "Works on my machine"                                            | Compose is the only supported run mode from Phase 6 onward; CI runs integration on fresh containers              |
| Recruiter never runs it                                          | 90-second video + screenshots in README; optional live Grafana link                                              |
| Time overrun                                                     | Phases 0–3 alone are already a strong project; 4–8 are compounding polish. Cut from the bottom, never the middle |

**Minimum shippable resume version:** Phases 0–3 + compose + README (≈4 weeks).
**Full version:** all phases (≈6–8 weeks part-time).

---

# PART 6 — QUICK REFERENCE: FIRST COMMANDS

```bash
# 0. scaffold
mkdir chainstake && cd chainstake && git init && pnpm init
# workspaces: apps/*, packages/*

# 1. contracts
forge init packages/contracts
# write StakingVault.sol, tests, deploy script

# 2. local chain
anvil --block-time 2 --mnemonic "test test ... junk"
forge script script/Deploy.s.sol --rpc-url localhost:8545 --broadcast

# 3. indexer
nest new apps/indexer
pnpm add viem typeorm pg @nestjs/schedule nestjs-pino \
  @willsoto/nestjs-prometheus prom-client \
  @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-grpc

# 4. sanity stake from CLI
cast send $TOKEN "approve(address,uint256)" $VAULT 100e18 --private-key $PK
cast send $VAULT "stake(uint256)" 100e18 --private-key $PK
```

Build order within any phase: **make it work → make it correct (tests) → make it observable → commit.**
