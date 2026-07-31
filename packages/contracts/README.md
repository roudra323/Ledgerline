# @chainstake/contracts

Foundry project for the ChainStake staking contracts.

## Contracts

- **`StakingVault.sol`** — `stake()`, `withdraw()`, `claimRewards()`, owner `pause()/unpause()`,
  simple linear reward accrual. Emits self-contained events (`Staked`, `Withdrawn`,
  `RewardsClaimed`, `Paused`, `Unpaused`) carrying amount **and** resulting total.
- **`MockToken.sol`** — ERC20 staking asset with an open `mint` for dev/tests/loadgen.

## Setup

```bash
# Install dependencies (populates lib/ — git-ignored)
forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts

forge build
forge test -vvv
forge test --match-test invariant -vvv   # invariant: sum(stakes) == token.balanceOf(vault)
```

## Deploy locally

```bash
anvil --block-time 2 --mnemonic "test test test test test test test test test test test junk"
pnpm --filter @chainstake/contracts deploy:local
# writes addresses -> packages/shared/src/addresses.local.json
```

> Contracts are currently **stubs** (`TODO(Phase 0)` markers). See `docs/build-plan.md` Phase 0.
