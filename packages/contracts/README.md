# @ledgerline/contracts

Foundry project for the Ledgerline payment contracts.

> **Status: design, not code.** Both contracts are interface stubs (events and errors, with the
> specification in their NatSpec) until Part 2 of [`docs/progress.md`](../../docs/progress.md).
> Everything below describes what Part 2 builds.

## Contracts

- **`StableUSD.sol`** (USDX) — a FiatToken-shaped issuer stablecoin: 6 decimals, minter
  allowances, blacklist, pause, EIP-2612 `permit`, EIP-3009 authorized transfers.
- **`PaymentProcessor.sol`** — settlement, refund and payout routing. **A conduit, never a vault:**
  `token.balanceOf(processor) == 0` after every action.

## The two invariants that matter

Everything else here is convenience. These two are the only things standing between a server bug
and a double payment (see [ADR-0009](../../docs/decisions/0009-on-chain-vs-off-chain.md)):

1. `settle()` reverts `PaymentAlreadySettled` if the payment id exists — a duplicate submission
   from a crashed-and-restarted submitter can never double-pay a merchant.
2. `refunded + amount <= amount settled`, else `RefundExceedsCapture` — partial-refund overrun is
   impossible even if every off-chain check is wrong. The settled amount is the merchant's **net**:
   the platform fee is taken off-chain by the ledger, and `settle()`'s fee is 0
   ([ADR-0018](../../docs/decisions/0018-ledger-flow-postings.md)).

## Commands

```bash
forge build
forge test -vvv
forge test --match-test invariant -vvv   # both invariant suites (Block 2.6)
forge fmt
```

## Note on EIP-3009

Merchant payments use **`receiveWithAuthorization`**, not `transferWithAuthorization`. The latter
can be front-run by anyone who sees the signed authorization in the mempool, which grief-fails the
intended relayer's transaction and desynchronizes the saga. `receiveWithAuthorization` requires
`msg.sender == to`, so only `PaymentProcessor` can execute it.
