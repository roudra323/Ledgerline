# ADR-0015 — The FX rounding residual is denominated in the source asset

**Status:** Accepted

## Context

[ADR-0001](0001-money-representation.md) requires that cross-asset movement never lose or invent a
minor unit: `convert()` is the single function permitted to change scale, it returns
`{ amount, residual }`, and **the residual is journaled to `3900 rounding_residual`, never dropped**.
Dust that is silently discarded is precisely what makes a trial balance drift.

ADR-0001 specifies that shape but never says what unit `residual` is expressed in. The original
implementation returned the raw remainder of the internal division:

```ts
const converted = totalNumerator / totalDenominator;
const residual = totalNumerator % totalDenominator; // unit: ???
```

The 2026-09-06 audit found that this value's unit **silently changes with the direction of the scale
change**, because the scale factor lands on a different side of the fraction in each branch:

| Direction                               | `totalDenominator` | Unit of `residual`                 |
| --------------------------------------- | ------------------ | ---------------------------------- |
| Downscale (`toDecimals < fromDecimals`) | `rateDen · 10ⁿ`    | source minor units ÷ `rateDen`     |
| Upscale (`toDecimals ≥ fromDecimals`)   | `rateDen`          | **target** minor units ÷ `rateDen` |

At a 1:1 rate the downscale case coincidentally yields exactly the source minor units, which is why
`money.spec.ts`'s two existing assertions passed against a wrong function for the life of Block 1.1.
Converting 10000 USD-cents to USDX at 1/3 returned `residual = 1`, meaning **one third of one USDX
minor unit** — a quantity of no asset, which `numeric(38,0)` cannot represent and no account can hold.

`3900 rounding_residual` is seeded once per asset (`USD`, `USDX`, `ETH`). Posting an unlabelled
fraction into one of them is not a rounding error; it is an invented amount.

## Decision

`residual` is **an amount in the SOURCE asset's minor units**: the part of `amountMinor` that was too
small to buy another whole minor unit of the target asset.

Fold the scale change into the rate so the conversion is one rational multiply in either direction,
then take the **ceiling** of the round trip — the smallest source amount that still yields
`converted`:

```ts
const converted = (amount * rateNumerator) / rateDenominator; // floor
const consumed = ceilDiv(converted * rateDenominator, rateNumerator);
const residual = amount - consumed;
```

Not a floor. Flooring `consumed` double-floors whenever the rate does not divide evenly:
`convert("1", 0, 1, "1", "3")` would report buying 3 target units **and** leave the whole source unit
as residual, booking the same unit twice. `adversarial-tester` caught that in the first version of
this fix.

`amount === consumed + residual` holds by construction, `residual ≥ 0` always, and the residual is a
real amount in a named asset — so it posts to `3900 rounding_residual` in the **source** asset and the
FX pair balances on both sides, as the worked example in
[`architecture.md`](../architecture.md) §3.3 requires.

The field keeps the name `residual`. ADR-0001 fixed the shape `{ amount, residual }` and ADRs are
immutable; this ADR pins the semantics ADR-0001 left open rather than superseding it.

## Alternatives considered

| Alternative                                                          | Why it lost                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Residual in the **target** asset                                     | The dust exists precisely because it is _smaller than one target minor unit_. Expressed in the target asset it is always `0` — the information is destroyed by the representation, which is the bug restated, not fixed.                                                                           |
| Return `{ amount, residualNumerator, residualDenominator }`          | Honest about the mathematics, and the caller could journal it exactly. But it pushes an unresolved rational into every call site in Parts 6, 8 and 9, and each one would have to make this same decision — badly, eventually, and differently. One function decides once.                          |
| Round half-up instead of flooring, and journal the signed difference | Makes `residual` sometimes negative, so `3900` would take entries on both sides. Defensible in isolation, but it means the platform sometimes _creates_ a minor unit it did not receive. Flooring guarantees the platform never credits more than it took in, which is the conservative direction. |
| Drop the dust and log it                                             | Forbidden by ADR-0001 and golden rule 4, and it is the exact mechanism reconciler I3 exists to detect. A log line is not a journal entry.                                                                                                                                                          |

## Consequences

**Good.** The residual is postable without any further conversion, in either scale direction, at any
rate. `convert()`'s output can be handed straight to `LedgerService.post()`.

**Good.** `amount === consumed + residual` is a property test, not a comment — the same conservation
guarantee `splitFee()` already gets from deriving `net = amount - fee`.

**Good.** Both pre-existing `money.spec.ts` assertions still pass unchanged, which is evidence the
change corrects an underspecified unit rather than altering agreed behaviour.

**Bad.** On a large downscale the residual can be large in source units (up to `10ⁿ − 1` — nearly a
whole cent's worth of USDX minor units). That is correct and it is the point, but a reader who
expects "dust" to mean "one or two units" will be surprised. `convert()`'s JSDoc names the unit;
this ADR is where the magnitude is recorded.

**Bad.** `convert()` now performs two divisions instead of one. Irrelevant next to a database round
trip, noted only so nobody rediscovers it as an optimisation.
