# infra

The one-command demo stack. Run from the repo root with `make demo` (or `make up` for the core
stack without the load generator).

## Services

| Service             | Port      | Purpose                                         |
| ------------------- | --------- | ----------------------------------------------- |
| `anvil`             | 8545      | Local deterministic chain (2s blocks)           |
| `anvil2`            | —         | Second RPC for failover demos (`ha` profile)    |
| `deployer`          | —         | Deploys contracts once, writes addresses, exits |
| `postgres`          | 5432      | Projection + raw_events store                   |
| `indexer`           | 3001      | Indexing engine + read API + `/metrics`         |
| `web`               | 3000      | Demo UI                                         |
| `loadgen`           | —         | Randomized tx firehose (`demo` profile)         |
| `prometheus`        | 9090      | Metrics scrape + alert rules                    |
| `grafana`           | 3002      | Provisioned dashboards (anonymous viewer)       |
| `otel-collector`    | 4317/4318 | OTLP ingest → Jaeger                            |
| `jaeger`            | 16686     | Trace UI                                        |
| `alertmanager`      | 9093      | Alert routing to a demo webhook                 |
| `postgres-exporter` | —         | Postgres metrics for Prometheus                 |

## Profiles

- default: core stack (chain, db, indexer, web, observability).
- `demo`: adds `loadgen` for living data.
- `ha`: adds `anvil2` for RPC-failover demos.

## Provisioning-as-code

Grafana datasources + dashboards and Prometheus rules live in git and load automatically on
`compose up` — never hand-clicked. See `docs/observability.md`.
