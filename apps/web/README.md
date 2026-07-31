# @chainstake/web

Deliberately minimal Next.js demo UI. It exists to make the demo **visceral**, not to show off React.

## What it does (Phase 5)

- Connect wallet (wagmi + viem) to local Anvil.
- Stake / withdraw forms writing to `StakingVault`.
- Balance + history table polling the **indexer API** (`NEXT_PUBLIC_API_URL`) — not the chain.
- "Data as of block N / lag Xs" badge from `GET /health/indexer`, surfacing eventual consistency
  honestly.

## Dev

```bash
pnpm --filter @chainstake/web dev   # http://localhost:3000
```

Env: see `NEXT_PUBLIC_*` in the root `.env.example`.
