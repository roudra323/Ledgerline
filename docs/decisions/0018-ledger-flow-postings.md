# ADR-0018 — The merchant is owed from the FX posting; issuance is a treasury posting

**Status:** Accepted

## Context

The canonical worked $100 on-ramp in [`architecture.md`](../architecture.md) §3 had never been
executed. Run against the migrated schema on 2026-09-18, **T5 was rejected at COMMIT**:

```
ERROR:  ledger account … went negative (balance -99000000) but allows_negative = false
```

The T5 posting debits `2000 merchant_payable` to discharge what we owe the merchant, but no earlier posting ever
credited it, and per-merchant accounts are created with `allows_negative = false`
(`account-registry.service.ts`). The example was balanced and wrong — the shape
[`ARCHITECTURE-WALKTHROUGH.md`](../ARCHITECTURE-WALKTHROUGH.md) §7 warns about.

It was wrong in a second way. T3 credited `2500 stablecoin_issued` on every payment, which is per-
payment issuance. [ADR-0013](0013-treasury-float-model.md) decided the opposite — minting is a
treasury operation on its own cadence, and settlement transfers from a finite float — but never said
which accounts a mint posts to. Under the old T3 the ledger's `2500` grew per payment while
`totalSupply()` grew per rebalance, so invariant I3 would drift on every payment. The old T4 reserved
from `1810 fx_clearing:USDX` rather than from `1100 token_treasury`, so the float ADR-0013 is about
was never drawn down by the ledger at all.

The refund and payout state machines in [`build-plan.md`](../build-plan.md) §2.2–2.3 inherited the
same model: both debited `merchant_payable` after settlement had already discharged it, and both
credited `1150 token_in_transit` with no matching debit. The 2026-09-06 audit recorded the payout
symptom and deferred it to Part 9; this ADR resolves all three flows together, because they share
one model.

## Decision

**We start owing the merchant at the FX posting, and issuance is its own posting.** Every posting
below was executed against the migrated schema before this ADR was written, and
`apps/indexer/test/ledger-flows.integration-spec.ts` re-proves each of them — except three that are
described but not yet exercised: the payout's debt-netting leg, the refund variant that credits
`1010`, and the on-ramp compensation reversal, which needs `reverses_id` support in `post()`
(Block 4.4).

### Treasury operations (never part of a payment)

```
T0  treasury.mint       DR 1100 token_treasury    / CR 2500 stablecoin_issued   USDX
    treasury.psp_sweep  DR 1010 bank_settlement   / CR 1000 psp_receivable      USD
```

`treasury.mint` journals every mint: the deployer's genesis float, an operator-invoked mint, and the
automatic rebalance when it exists. `treasury.psp_sweep` journals the PSP paying our balance out to our
bank; without it `1010` could never hold the cash a fiat payout draws on.

### On-ramp — $100.00, 1% fee, 1:1

```
T1  onramp.capture   DR 1000 psp_receivable      USD      10000
                     CR 2100 unsettled_capture   USD      10000
T3  onramp.fx        DR 2100 unsettled_capture   USD      10000
                     CR 4000 fee_revenue         USD        100
                     CR 1800 fx_clearing:USD     USD       9900
                     DR 1810 fx_clearing:USDX    USDX  99000000
                     CR 2000 merchant_payable:M  USDX  99000000
T4  onramp.reserve   DR 1150 token_in_transit    USDX  99000000
                     CR 1100 token_treasury      USDX  99000000
T5  onramp.settled   DR 2000 merchant_payable:M  USDX  99000000
                     CR 1150 token_in_transit    USDX  99000000
```

- **T3 writes the IOU; T5 tears it up.** Between them, `2000:M` holds exactly what we owe and have not
  yet delivered — which is what failure mode B16 freezes and what invariant I5 counts.
- **T4 draws on the float.** `1100` is `allows_negative = false`, so the database itself refuses to
  reserve tokens the treasury does not hold. The saga still checks first and parks in
  `awaiting_liquidity`; the trigger is the backstop.
- **`1800`/`1810` hold a standing FX position** (−$99 / +99 USDX after this payment). They are a
  clearing pair that nets to zero _at the rate_, not accounts that return to zero; the payout's
  `payout.burned` is what unwinds them.

**Compensation, chain submit reverted** (`refunding → refunded`): reverse T1, T3 and T4 in full,
**including the fee** — the failure was ours, so the merchant owes nothing. The reversal mechanics
(`reverses_id`) are Block 4.4's.

**Blacklisted before settlement** (B16, any state after T3 and before T5):

```
compliance.frozen    DR 2000 merchant_payable:M  / CR 2200 frozen_payable:M   USDX
                     DR 1100 token_treasury      / CR 1150 token_in_transit   USDX
```

The tokens never left, so the reservation is released; the obligation is reclassified, not
cancelled. After T5 there is nothing to freeze in the ledger — the tokens are in the merchant's
custody, and the on-chain blacklist is the control.

### Refund — after settlement, the platform keeps its fee

The merchant received only the net. The customer is refunded in full, so the merchant funds the
refund: tokens reclaimed = `convert(refund)`, capped at the payment's remaining on-chain refundable
amount (`PaymentProcessor`'s `refunded + amount <= amount`); any USD not covered becomes merchant
debt in `1300 merchant_receivable:M`.

```
refund.chain_reversed   DR 1100 token_treasury     / CR 1810 fx_clearing:USDX   USDX  reclaimed
refund.fiat_returned    DR 1800 fx_clearing:USD      reclaimed, in USD          USD
                        DR 1300 merchant_receivable:M  shortfall                USD
                        CR 1000 psp_receivable         refund amount            USD
```

A full $100 refund reclaims 99 USDX and leaves $1 of merchant debt; `4000 fee_revenue` is untouched.
Two $50 refunds reclaim 50 then 49 USDX, and only the second creates debt. There is no burn: the
reclaimed tokens are treasury float again, and supply does not change. `refund.initiated` posts
nothing — nothing has moved when a refund is requested.

The fiat leg credits `1000` because the PSP funds a refund from our balance with it. If the PSP has
already swept that balance to our bank, it debits the bank instead and the credit leg is `1010`; which
one happened is the PSP's fact, reported by the `fiat_events` that drive this transition.

### Payout — the merchant's tokens, burned, then fiat

The merchant holds its tokens in its own wallet, so the ledger has no merchant USDX balance to
check. The guard is `token.balanceOf(merchant) >= amount` — a pre-flight hint; the burn itself is the
enforcement, and it reverts if the tokens are not there. `payout.requested` and `submit_burn` post
nothing.

```
payout.burned     DR 2500 stablecoin_issued       amount     USDX
                  CR 1810 fx_clearing:USDX        consumed   USDX
                  CR 3900 rounding_residual       residual   USDX
                  DR 1800 fx_clearing:USD         converted  USD
                  CR 2010 merchant_fiat_payable:M converted  USD
payout.settled    DR 2010 merchant_fiat_payable:M / CR 1010 bank_settlement   USD
payout.returned   DR 1010 bank_settlement / CR 2010 merchant_fiat_payable:M   USD
```

`convert(amount, 6, 2, rateNum, rateDen)` returns `{ amount: converted, residual }`, with the residual
in the source asset (ADR-0015); `consumed` is `amount − residual`, the source units that bought
`converted`. So 99.000050 USDX pays $99.00 and journals 50 USDX minor units to `3900`. If the merchant
owes us (`1300:M > 0`, failure mode A12), the payout nets it: `DR 2010:M / CR 1300:M`.

### The platform fee is taken off-chain

The fee is `4000 fee_revenue` in USD at T3. `PaymentProcessor.settle()` is called with the **net**
amount and its fee is 0; its `fee`/`netAmount` event fields stay, so the event shape does not change
if that is ever revisited. Charging both would take the fee twice.

### Kinds

This needs five kinds the `CHECK` did not have — `treasury.mint`, `treasury.psp_sweep`,
`payout.returned`, `compliance.frozen`, and `reconciliation.adjustment` (named by `runbook.md` for
auto-heal) — added by migration `1754006400008`. `refund.initiated` and `payout.requested` now post
nothing but stay in the `CHECK`, because the set is append-only ([ADR-0016](0016-transaction-kind-vocabulary.md)).

## Alternatives considered

| Alternative                                                    | Why it lost                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never credit `merchant_payable` on the on-ramp; T5 moves float | T5 would then be `DR 2500 / CR 1150`. It posts, but `2000:M` is zero for the payment's whole life, so B16 has no obligation to freeze into `frozen_payable` and I5 has no discharges to count. Two documented designs would need rewriting to save one credit leg.              |
| Keep per-payment issuance at T3 (`CR 2500`)                    | Contradicts ADR-0013: supply would be recorded per payment but minted per rebalance, so I3 drifts on every payment until the next mint. It also leaves `1100` untouched by payments, so the float ADR-0013 exists to exercise would never move in the ledger.                   |
| The platform returns its fee on a refund                       | Simpler — no debt path, and `1800`/`1810` unwind exactly. Rejected as a business decision: the fee pays for a capture that happened, and the platform keeps it, as card processors do. The cost is `1300` debt on every full refund, which A12's netting already has to handle. |
| Burn reclaimed refund tokens                                   | The old refund design. Supply would shrink and the treasury would have to re-mint the same tokens at the next rebalance — two on-chain operations and two supply changes to arrive where not burning starts.                                                                    |
| Take the fee on-chain in `PaymentProcessor.settle()`           | A USDX fee is a second fee asset to reconcile, and it moves the fee out of the ledger's USD revenue into a token balance at `feeRecipient`. Doing both would double-charge.                                                                                                     |

## Consequences

**Good.** Every posting in the three flows is executable against the real schema, and the flows
test turns any future edit that breaks one into a failing build rather than a Part 6 surprise.

**Good.** The database now enforces float: a reservation larger than `1100` is rejected at COMMIT,
under the same account row lock ADR-0017 added, so concurrent reservations cannot overdraw it.

**Good.** I3 holds by construction — `2500` moves only when tokens are minted or burned, which is when
`totalSupply()` moves.

**Bad.** `1800`/`1810` carry standing balances, so "the clearing pair is transient" — said in several
documents before this — is false, and a dashboard on either account shows a large, legitimate
number. Only its pairing at the rate is an invariant.

**Bad.** A full refund always leaves merchant debt equal to the fee. That debt must be netted,
chased or written off; A12's machinery is now on the refund path, not only the chargeback path.

**Bad — and a boundary, not a guarantee.** The ledger does not bind a refund to its payment.
`refund.chain_reversed` names only `1100` and `1810`, and `1810` may go negative, so the database
accepts a reclaim of any amount with no settlement behind it — `ledger-flows.integration-spec.ts`
proves it. The refund cap lives where ADR-0009 and failure mode C9 put it: the refund saga's guard
and a constraint on the `refunds` table (both Part 8), and on-chain, where `PaymentProcessor` reverts
`RefundExceedsCapture` so a phantom reclaim cannot happen for real. Reconciliation would still catch
one: tokens the ledger thinks came back but the chain never moved break I4. Unlike the float check on
`1100`, no **ledger** constraint holds the cap, and the ledger should not be described as if one did.

**Bad.** Two kinds are now dead but permanent. That is the price ADR-0016 accepted for an
append-only idempotency key.

## Relation to earlier ADRs

Merged ADRs are immutable, so where their wording no longer matches this model, it is corrected here:

- **ADR-0009** listed the platform fee as charged and emitted on-chain per settlement. **Superseded**
  for that point only (its status line says so): the fee is off-chain, above.
- **ADR-0013** is refined, not replaced — this ADR names the accounts a mint posts to. Its title's
  "on-ramp both mints and transfers" means the system both mints (treasury) and transfers (on-ramp);
  the on-ramp itself never mints, as the ADR's own decision says.
- **ADR-0001** and **ADR-0004** describe cross-asset movement as "two balanced transactions". It is
  one transaction (`onramp.fx`, `payout.burned`) whose legs balance separately per asset — exactly
  what the per-asset balance trigger enforces. ADR-0004's rejected alternative, "one balanced
  transaction spanning USD and USDX", means balancing _across_ assets, which is still rejected.
  ADR-0004's "a $100 on-ramp is four transactions and ten entries" is four and **eleven** (T3 has
  five legs).
- **ADR-0008** lists the reversible checks as running "before the burn or the mint"; on the
  on-ramp, read "the mint" as the transfer from the treasury.

This resolves the payout item the 2026-09-06 audit deferred to Part 9.
