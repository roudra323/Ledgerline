# @chainstake/shared

Cross-cutting artifacts shared by the indexer, web app, and loadgen:

- **`src/abis/`** — typed contract ABIs (`as const` for viem inference), generated from
  `packages/contracts/out` (Phase 0).
- **`src/types/`** — shared domain types (`Address`, `ContractName`, `StakingEventName`, …).
- **`src/addresses.ts`** — deployed contract addresses; the deployer writes `addresses.local.json`
  (git-ignored) at chain boot.

Consume via the workspace name:

```ts
import { addresses, type StakingEventName } from "@chainstake/shared";
```
