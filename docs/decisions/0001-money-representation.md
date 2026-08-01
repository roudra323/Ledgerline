# ADR-0001 — Money is an integer minor unit of a named asset

**Status:** Accepted

## Context

Ledgerline moves USD (2 decimal places), USDX (6, matching real USDC) and ETH (18). A single
mis-scaled arithmetic operation is a direct money-loss bug, and floating point is not an option at
any point in the stack.

## Decision

Every amount is an **integer in the minor unit of a named asset**:

- Postgres: `numeric(38,0)`
- TypeScript: `string` (which is what TypeORM returns for `numeric` anyway)
- `bigint` only _inside_ arithmetic helpers, never at a boundary

Scale belongs to the **asset**, not the row. The `assets` table is the single registry of
`(asset_code, decimals)`.

**Hard rule:** an arithmetic expression may only combine amounts with the same `asset_code`.
Cross-asset movement is never a subtraction — it is two balanced ledger transactions joined through
an FX clearing pair.

Exactly one function is permitted to change scale:

```ts
convert(amountMinor, fromAsset, toAsset, rateNum, rateDen): { amount: string; residual: string }
```

It returns the **floor** result and the **residual explicitly**. Callers must post the residual to
`3900 rounding_residual`. Dust is never dropped; it is journaled.

## Alternatives considered

| Alternative                         | Why it lost                                                                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bigint` / `int8` columns           | Fits 6-decimal tokens fine, but not 18-decimal ones. You inherit a schema migration the day you index a real 18-decimal ERC-20. `numeric(38,0)` costs essentially nothing at our volume. |
| `numeric(38,6)` holding human units | Reintroduces the "is `1.10` equal to `1.100000`?" class of bug and makes equality and `SUM` comparisons subtly scale-dependent. Integers make reconciliation exact.                      |
| `decimal.js` in TypeScript          | Still needs a database representation, so it solves nothing at the layer that matters — and adds a dependency for a problem integers do not have.                                        |
| Store `amount` + `decimals` per row | Denormalized, and it invites mixed-scale arithmetic by making the scale look like a per-row property.                                                                                    |

## Consequences

**Good.** The trial balance can be asserted as exact integer equality, forever. There is no
tolerance, no epsilon, no "close enough" — which is what makes invariant I1 a real test rather than
a soft check.

**Good.** Journaling the residual means every rounding decision in the system's history is
inspectable. "Where did the half-cent go?" has an answer.

**Bad.** `string` arithmetic is verbose at call sites, and TypeScript will not stop you from
concatenating two amounts with `+`. Mitigation: a small `Money` helper module is the only place
amounts are unwrapped, and a lint rule flags `+` on anything named `*_minor`.

**Bad.** The FX clearing pair makes a simple currency conversion into two postings and six entries.
That is genuinely more code — and it is also how every real multi-currency ledger works, because
"sums to zero across different units" is not an invariant.
