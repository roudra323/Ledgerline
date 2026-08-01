# ADR-0007 — Sagas advance on confirmed events, never on receipts

**Status:** Accepted

## Context

Once a transaction is broadcast, there are two ways to learn what happened: poll
`eth_getTransactionReceipt` for the hash we sent, or wait for the indexer to observe the emitted
event at confirmation depth.

The receipt is available in seconds. The indexed event takes as long as the confirmation policy says.
The temptation to credit on the receipt is exactly the temptation that produces the classic exchange
loss.

## Decision

**The submitter writes; the indexer observes; only the indexer moves a saga past a value-bearing
point.**

```
Submitter ──tx──> Chain ──event──> Indexer ──raw_events──> Handler ──> saga_transitions
ChainTxWatcher ──receipt──> chain_transactions        (status only, no saga effect)
```

- `ChainTxWatcher` polls receipts and updates `chain_transactions` for operator visibility and
  fast UX. It does **not** credit anything.
- `PaymentSettledHandler` looks up the intent by `onchain_payment_id` (`keccak256(intent_uuid)`),
  asserts the amount matches the snapshot, and appends the transition with
  `cause = ('raw_event', raw_event.id)`. Replayable, idempotent, reorg-safe.
- Both paths converge on the same `chain_transactions` row; conflicts resolve in favour of the event
  path.

**One exception.** `receipt.status = 0` — a revert — _does_ drive a saga, because a revert emits no
events and the event path can therefore never learn about it. It only ever drives the saga **toward
compensation, never toward crediting**. The revert reason is decoded by re-running `eth_call` with
identical parameters at `mined_block_number - 1`.

`confirmations_required` is **per-kind risk policy, not a constant**: `settle = 2` on Anvil (`12`
real); `payout_burn = 2 × settle`, because a payout triggers an irreversible fiat transfer.

## Alternatives considered

| Alternative                               | Why it lost                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credit on the receipt                     | This is the textbook exchange-deposit loss vector. A receipt says "included in _a_ block," not "included in _the canonical_ chain." Reorg-after-credit becomes a real loss instead of a self-healing rollback.      |
| Credit on the receipt, reconcile later    | "Later" is after the merchant has already moved the tokens. Compensation for a non-custodial delivery does not exist (see [ADR-0008](0008-compensation-ordering.md)).                                               |
| Event path only, ignore receipts entirely | Then a reverted transaction is invisible forever: it emits nothing, so the saga sits in `chain_submitted` until a timeout, and we lose the decoded revert reason that tells us _which_ compensation branch to take. |
| A fixed global confirmation depth         | Treats a $1 settlement and an irreversible six-figure payout as the same risk. Depth is a risk budget and should be spent where the irreversibility is.                                                             |

## Consequences

**Good.** A reorg within confirmation depth is a self-healing event: the guard orphans the events, a
compensating transition and a reversing ledger transaction are posted, the chain transaction returns
to `submitted`, and the whole thing replays when it is re-included.

**Good.** Replay works. Because sagas advance on `raw_events` rows, replaying the log reproduces every
saga transition exactly — which is what makes the replay-determinism test meaningful for the
_orchestration_ layer and not just the balances.

**Good.** The rule is simple enough to state in one sentence and check in review: _does this code path
credit anything based on something other than an indexed, confirmed event?_

**Bad.** Settlement latency is bounded below by confirmation depth times block time, and the merchant
sees `processing` for that whole window. This is honest rather than fast, and the UI says so
explicitly with a "data as of block N" badge.

**Bad.** Two paths write to `chain_transactions`, so there is a precedence rule to remember. Mitigated
by making it explicit (event path wins) and by the fact that the watcher only ever writes status
fields the event path does not own.
