# @chainstake/loadgen

A small but **first-class** deliverable: it fires randomized stake/withdraw/claim transactions
against Anvil so the Grafana dashboards and Jaeger traces have living data during demos. Empty
dashboards kill a demo — this is what makes the screenshots look real.

Runs under the `demo` compose profile:

```bash
make demo   # docker compose --profile demo up
```

Config via env (see root `.env.example`): `RPC_URL_PRIMARY`, `DEV_MNEMONIC`, contract addresses.
Implemented in **Phase 5**.
