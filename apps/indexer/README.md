# @chainstake/indexer

NestJS service: the **indexing engine**, the **read API**, and **admin** operations.

## Structure

```
src/
├── blockchain/
│   ├── core/         ChainClient, LogFetcher, AdaptiveChunker, SyncStateService,
│   │                 ReorgGuardService, IndexerService (the runChunk loop)
│   ├── events/       @OnChainEvent decorator, EventRegistryService, handlers (Staked, Withdrawn)
│   ├── entities/     TypeORM entities: raw_events, sync_state, indexer_failures,
│   │                 staking_records, user_balances, contract_status
│   ├── migrations/   TypeORM migrations
│   └── data-source.ts
├── api/              read endpoints: /users/:address/{balance,history}, /stats, /health/indexer
├── admin/            ReplayService, ReconciliationService, guarded admin endpoints
├── observability/    otel.ts (imported first!), MetricsService, logger
├── app.module.ts
└── main.ts
```

## Local dev

```bash
pnpm --filter @chainstake/indexer start:dev
```

Requires a reachable Postgres and RPC endpoint (see root `.env.example`). The full stack runs via
`make demo` from the repo root.

## Build order (per phase)

Follow `docs/build-plan.md`. Every source file here is a **stub** with a `TODO(Phase N)` marker
describing what fills it in. Work rhythm: **make it work → make it correct → make it observable → commit.**

## Key invariants

- `raw_events` is append-only and idempotent (`UNIQUE(chain_id, tx_hash, log_index)`).
- Cursor advance + inserts happen in one transaction.
- `user_balances` is aggregate-recomputed (order-independent), never incremented.
- Metric labels stay low-cardinality — no addresses or tx hashes as labels.
