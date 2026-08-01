# ADR-0008 — Order compensations so the recoverable failure is last

**Status:** Accepted

## Context

Every saga in Ledgerline crosses two systems that cannot share a transaction. Each multi-leg flow
therefore has an ordering choice, and the ordering determines what happens when the second leg fails.

There is no ordering that eliminates failure. There is an ordering that determines whether the
failure is an SLA problem or a solvency problem.

## Decision

**Always order the legs so that the failure you cannot recover from happens first, while you still
control both sides — and the failure you _can_ recover from happens last.**

Applied:

| Flow        | Order                                               | If the last leg fails                                                                                   |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Refund**  | Claw back the token **first**, then refund the card | The customer's refund is delayed — an SLA problem, retryable indefinitely                               |
| **Payout**  | Burn **first**, then send the fiat                  | The merchant's payout is delayed; `merchant_fiat_payable` stays open. We still owe them, and we know it |
| **On-ramp** | Capture fiat first, then deliver tokens             | If delivery fails we still hold the fiat and can refund it — the reversible side is the one we retain   |

**Batching** is inserted _after_ `burn_confirmed`, never before. Burns stay per-payout and
fine-grained — good for the indexer, good for reconciliation — and only the bank-file submission
batches, which is the only leg that actually benefits from batching.

Corollary rule: **everything reversible happens strictly before the first irreversible step.**
Screening, velocity limits, float reservation and simulation all run before the burn or the mint, not
after.

## Alternatives considered

| Alternative                                                   | Why it lost                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Refund: fiat first, then chain**                            | If the on-chain claw-back then fails — the merchant already moved the tokens, or the merchant is blacklisted — we have paid the customer _and_ the merchant keeps the tokens. A guaranteed loss with no recovery path.                                                                                                                |
| **Refund: both legs in parallel**                             | Same loss window as fiat-first, plus a harder reconciliation and a race in the ledger. Parallelism buys latency we do not need on a refund.                                                                                                                                                                                           |
| **Payout: fiat first, then burn**                             | If the burn fails, the merchant has both the fiat and the tokens. Same shape, same unbounded loss.                                                                                                                                                                                                                                    |
| **Payout: re-mint as the compensation for a failed fiat leg** | Superficially symmetric, actually wrong: a re-mint changes the reserve math and breaks invariant I7 for reasons that have nothing to do with reserves. The correct compensation is that `merchant_fiat_payable` stays open — we owe them fiat, and the ledger says so. Re-mint exists only as an operator command under dual control. |
| **Batch the burns too**                                       | Coarsens the on-chain record, so one reverted batch entry poisons N payouts, and reconciliation loses the per-payout granularity that makes I5 checkable.                                                                                                                                                                             |
| **Two-phase commit across the PSP and the chain**             | Neither participant implements it, and neither ever will. This is the constraint, not a design option.                                                                                                                                                                                                                                |

## Consequences

**Good.** Every failure mode in the compensation matrix resolves to either "retry" or "we owe someone
a known amount, recorded in the ledger." There is no branch where we have irrecoverably paid the same
value twice.

**Good.** The rule is one sentence, so it is reviewable. "Which leg is recoverable, and is it last?"
is a question you can ask about any new flow.

**Good.** It makes the irreversibility map (see `failure-modes.md`) short and honest, because the
ordering has already removed the cases that would otherwise appear there.

**Bad.** The user-visible latency lands on the leg the _customer_ cares about. A refund reaches the
card after the token claw-back confirms, which is slower than refunding immediately. That is a
deliberate trade of perceived speed for actual solvency, and the merchant-facing API says
`processing` honestly rather than lying about it.

**Bad.** The irreversible step happens early, which means a bug in the _later_ legs is discovered
after the point of no return. Mitigation: everything reversible — screening, limits, float,
simulation — is front-loaded before that step, precisely so the irreversible action is the
best-informed one we can make.
