# @ledgerline/indexer

The core service. Ingests **both** source-of-truth logs, orchestrates the sagas, owns the ledger,
writes to the chain, and serves the read API.

## Modules

| Module           | What                                                                           |
| ---------------- | ------------------------------------------------------------------------------ |
| `blockchain/`    | On-chain ingest: `runChunk` loop, adaptive chunking, reorg guard, `raw_events` |
| `fiat/`          | Off-chain ingest: webhook endpoint, `fiat_events`, dispatcher, PSP adapters    |
| `ledger/`        | Double-entry ledger. The **only** writer of `ledger_entries`                   |
| `sagas/`         | On-ramp, refund, payout orchestrators                                          |
| `chain-writer/`  | Signer port, signing policy, transaction submitter, receipt watcher            |
| `outbox/`        | Transactional outbox, `FOR UPDATE SKIP LOCKED`                                 |
| `compliance/`    | Three screening ports, gates at `pre_credit` / `pre_payout` / `periodic`       |
| `admin/`         | Replay, reconciliation, operator commands                                      |
| `api/`           | Read API. Projections only                                                     |
| `observability/` | OTel bootstrap, metrics, logger                                                |

## Commands

```bash
pnpm start:dev
pnpm migration:generate --name AddSomething
pnpm migration:run
pnpm test              # unit — no database needed
pnpm test:integration  # needs Postgres reachable at DATABASE_URL
```

`test:integration` creates a throwaway database (`ledgerline_test_<uuid>`), migrates it, runs the
suite against it and drops it. It never touches the database in `DATABASE_URL` itself — it only
borrows the connection to issue `CREATE DATABASE`, so that role needs the privilege. The ledger's
log tables are immutable by design, so a test cannot clean up after itself; a fresh database per run
is the only way the suite stays deterministic.

## The rule to remember

**Nothing is credited on a hint.** Receipts, `200`s and optimistic writes are hints. Sagas advance
only on indexed, confirmed events — with one exception, a revert, which drives compensation only.
