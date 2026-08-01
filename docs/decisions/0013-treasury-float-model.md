# ADR-0013 — The on-ramp both mints and transfers from a finite treasury

**Status:** Accepted

## Context

We control the minter role. The obvious on-ramp design is: fiat arrives, mint exactly that many
tokens, send them to the merchant.

That design has a problem which is easy to miss: **it makes float infinite.** If every settlement
mints on demand, the treasury can never run dry, liquidity is never a constraint, and every
interesting problem in the space — reservations, low-water alerts, concurrent claims on the same
balance, parking versus failing — simply does not arise on the on-ramp.

All of that content then lives exclusively on the off-ramp, which is the part of the build most at
risk of being cut for time. Cutting it would silently remove the liquidity story from the whole
project.

## Decision

Split the two concerns that the naive design conflates:

- **Issuance** — minting `StableUSD` against confirmed fiat reserves. Governed by the minter
  allowance, reconciled by invariants I3 and I7. Happens on a treasury-management cadence, not
  per-payment.
- **Settlement** — delivering tokens to a merchant **from a finite treasury balance**, guarded by a
  reservation into `1150 token_in_transit` taken under the account row lock _before_ submission.

A settlement that cannot be covered by treasury float **parks** in `awaiting_liquidity` and raises
`FloatBelowMinimum`. It does not mint its way out of the problem.

`liquidity_positions` carries `min` / `target` / `max` per asset; a rebalance job tops the treasury up
by minting toward `target` when it drops below `min`.

This is also closer to how Circle actually operates — Mint is a treasury operation, not something
that happens inside each individual payment.

## Alternatives considered

| Alternative                                       | Why it lost                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mint per settlement (the naive design)            | Float becomes infinite and the reservation machinery becomes dead code on the on-ramp. It also couples issuance to payment volume, so a payment spike silently expands supply — which is exactly the property a reserve-backed issuer must not have. |
| Never mint; pre-fund the treasury once at deploy  | Removes the issuance story entirely, so invariants I3 (supply matches the ledger) and I7 (reserve coverage) have nothing to check. The headline metric of the demo would be constant by construction.                                                |
| Mint per settlement, but cap the minter allowance | The allowance becomes a throughput limit rather than a safety limit, so operators would be pressured to keep raising it — which defeats the control it exists to be (failure mode B14).                                                              |
| Custodial merchant balances, settle on withdrawal | Makes float trivially manageable and removes non-custodial irreversibility, which is the property that makes the compensation matrix real. Rejected for the same reason in [ADR-0009](0009-on-chain-vs-off-chain.md).                                |

## Consequences

**Good.** Float reservation, low-water alerting, `awaiting_liquidity` parking and the
20-concurrent-payouts-against-float-for-10 test are all exercised by the on-ramp — the part of the
build that ships first and is never cut.

**Good.** Issuance is separable and observable. `ledgerline_minter_allowance_remaining_minor` and
reserve coverage (I7) mean something, because minting is a deliberate act with its own cadence rather
than an implicit side effect of traffic.

**Good.** A supply increase is always explainable: it came from a rebalance, not from a payment.

**Bad.** Two mechanisms where the naive design has one, and a rebalance job that must run for the
demo to sustain load. Mitigation: the load generator drives enough volume to trigger a rebalance,
which makes the mint visible on the dashboard — a feature for the demo rather than a cost.

**Bad.** A settlement can now fail for a reason unrelated to the customer or merchant (our treasury is
low). This is honest — it is a real operational condition — and it parks rather than failing, so the
customer sees `processing` rather than an error.
