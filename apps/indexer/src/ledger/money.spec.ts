import * as fc from "fast-check";

import { add, compare, convert, isZero, splitFee, sub } from "./money";

describe("money utilities", () => {
  describe("add", () => {
    it("adds two minor unit amounts correctly", () => {
      expect(add("100", "200")).toBe("300");
      expect(add("0", "50")).toBe("50");
    });

    // Catches: add() silently coercing through JS `number` instead of BigInt, which would lose
    // precision (or throw) for values beyond Number.MAX_SAFE_INTEGER. Money is numeric(38,0).
    it("preserves precision for amounts far beyond Number.MAX_SAFE_INTEGER", () => {
      const thirtyEightNines = "9".repeat(38);
      expect(add(thirtyEightNines, "1")).toBe(`1${"0".repeat(38)}`);
    });

    // Catches: a version of add() that rejects or mishandles negative BigInt strings, even though
    // the exported type signature doesn't forbid a caller from passing one (e.g. a reversing entry
    // computed elsewhere). The docstring only promises "adds two minor unit amounts" — it does not
    // claim to validate sign, so if the implementation silently produces a wrong (non-summed)
    // result for negative input that is a distinct, worse bug than throwing.
    it("sums negative BigInt-parseable strings arithmetically (docstring makes no non-negativity claim)", () => {
      expect(add("-100", "40")).toBe("-60");
    });
  });

  describe("sub", () => {
    it("subtracts minor unit amounts correctly", () => {
      expect(sub("300", "100")).toBe("200");
      expect(sub("100", "100")).toBe("0");
    });

    it("throws on negative result", () => {
      expect(() => sub("100", "200")).toThrow();
    });

    // Catches: an off-by-one in the negative-result guard (e.g. `diff <= 0n` instead of `diff < 0n`)
    // which would wrongly reject the boundary case of an exact-zero difference.
    it("does NOT throw when the difference is exactly zero (boundary of the negative guard)", () => {
      expect(() => sub("500", "500")).not.toThrow();
      expect(sub("500", "500")).toBe("0");
    });
  });

  describe("isZero & compare", () => {
    it("identifies zero correctly", () => {
      expect(isZero("0")).toBe(true);
      expect(isZero("100")).toBe(false);
    });

    // Catches: isZero() implemented via a naive string check (e.g. `a === "0"`) rather than
    // BigInt parsing, which would misclassify equivalent-but-differently-formatted zero strings.
    it("identifies zero regardless of string formatting (BigInt parse, not string compare)", () => {
      expect(isZero("-0")).toBe(true);
      expect(isZero("000")).toBe(true);
    });

    it("compares amounts correctly", () => {
      expect(compare("100", "200")).toBe(-1);
      expect(compare("200", "100")).toBe(1);
      expect(compare("100", "100")).toBe(0);
    });

    // Catches: compare() returning something other than exactly -1/0/1 (e.g. a raw difference)
    // for large gaps, which callers relying on strict -1/0/1 equality (per docstring) would misread.
    it("returns exactly -1/0/1 even for very large magnitude differences", () => {
      const huge = "99999999999999999999999999999999999999";
      expect(compare("0", huge)).toBe(-1);
      expect(compare(huge, "0")).toBe(1);
    });
  });

  describe("splitFee property-based tests (fast-check)", () => {
    it("fee + net === amount is ALWAYS guaranteed for any valid inputs", () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 0n, max: 1_000_000_000_000_000n }),
          fc.integer({ min: 0, max: 10000 }),
          (amount, bps) => {
            const { fee, net } = splitFee(amount.toString(), bps);
            const feeBig = BigInt(fee);
            const netBig = BigInt(net);

            // Invariant 1: Total conservation (fee + net === amount)
            const sumEqualsAmount = feeBig + netBig === amount;

            // Invariant 2: Fee & Net are non-negative
            const nonNegative = feeBig >= 0n && netBig >= 0n;

            return sumEqualsAmount && nonNegative;
          },
        ),
        { numRuns: 1000 },
      );
    });

    it("0 bps results in fee === 0 and net === amount", () => {
      const { fee, net } = splitFee("10000", 0);
      expect(fee).toBe("0");
      expect(net).toBe("10000");
    });

    it("10000 bps (100%) results in fee === amount and net === 0", () => {
      const { fee, net } = splitFee("10000", 10000);
      expect(fee).toBe("10000");
      expect(net).toBe("0");
    });

    // Catches: a version of splitFee() that throws (or silently misparses) on a negative bps
    // instead of the documented `bps < 0` guard.
    it("throws on negative bps", () => {
      expect(() => splitFee("1000", -1)).toThrow();
    });

    // Catches: an `if (bps)` truthiness check anywhere in the validation path that would
    // mis-route bps === 0 (a legitimate, falsy-but-valid value) as if it were missing/invalid.
    it("accepts bps === 0 without throwing (falsy-but-valid boundary)", () => {
      expect(() => splitFee("1000", 0)).not.toThrow();
    });

    // Catches: an amount-negativity check written as `if (amount)` or similar that would
    // silently skip validation for amountMinor === "0".
    it("does not reject a zero amount", () => {
      expect(splitFee("0", 500)).toEqual({ fee: "0", net: "0" });
    });
  });

  describe("convert", () => {
    it("converts USD (2 decimals) to USDX (6 decimals) at 1:1 rate", () => {
      // $100.00 (10000 cents) -> 100.000000 USDX (100000000 minor units)
      const { amount, residual } = convert("10000", 2, 6, "1", "1");
      expect(amount).toBe("100000000");
      expect(residual).toBe("0");
    });

    it("converts USDX (6 decimals) back to USD (2 decimals) with residual", () => {
      // 100.000050 USDX (100000050 minor units) -> $100.00 (10000 cents) + 50 residual
      const { amount, residual } = convert("100000050", 6, 2, "1", "1");
      expect(amount).toBe("10000");
      expect(residual).toBe("50");
    });

    // --- Category 5: the residual must be postable in the SOURCE asset (ADR-0015) -----------------

    describe("residual postability invariant (property-based)", () => {
      // Catches: any regression back toward `totalNumerator % totalDenominator` (or any other
      // formula) whose unit isn't source minor units — the defining bug this fix closed. If
      // `consumed + residual !== amountMinor`, the residual cannot be journaled to
      // `3900 rounding_residual` in the source asset without breaking Σdebits = Σcredits.
      it("consumed (converted worth back in source units) + residual === amountMinor, and residual is never negative, for arbitrary amount/scale/rate", () => {
        fc.assert(
          fc.property(
            fc.bigInt({ min: 0n, max: 10n ** 30n }),
            fc.integer({ min: 0, max: 18 }),
            fc.integer({ min: 0, max: 18 }),
            fc.bigInt({ min: 1n, max: 10n ** 12n }),
            fc.bigInt({ min: 1n, max: 10n ** 12n }),
            (amount, fromDecimals, toDecimals, rateNum, rateDen) => {
              const { amount: converted, residual } = convert(
                amount.toString(),
                fromDecimals,
                toDecimals,
                rateNum.toString(),
                rateDen.toString(),
              );

              // Re-derive "consumed" the same way the docstring defines it: the SMALLEST source
              // amount that still yields `converted` (a ceiling, not a floor — see money.ts's own
              // comment on `ceilDiv`). An independent recomputation from the public inputs/outputs,
              // not a call into convert()'s internals.
              const scaleDiff = toDecimals - fromDecimals;
              const scaleFactor = 10n ** BigInt(Math.abs(scaleDiff));
              const rateNumerator = scaleDiff >= 0 ? rateNum * scaleFactor : rateNum;
              const rateDenominator = scaleDiff >= 0 ? rateDen : rateDen * scaleFactor;
              const numerator = BigInt(converted) * rateDenominator;
              const consumed = (numerator + rateNumerator - 1n) / rateNumerator; // ceilDiv

              const residualBig = BigInt(residual);

              // The postability invariant itself.
              const conserves = consumed + residualBig === amount;

              // Residual must never be negative (it is a real amount in a real asset column).
              const nonNegative = residualBig >= 0n;

              return conserves && nonNegative;
            },
          ),
          { numRuns: 2000 },
        );
      });

      // Catches: any regression to a floor-based (rather than ceiling-based) `consumed`
      // computation. Docstring claims residual is "the part of amountMinor that was too small to
      // buy another whole minor unit of the target asset" — i.e. running the residual back through
      // convert() at the same rate must yield zero additional target units. A floor-based
      // `consumed` breaks this: it can undercount `consumed` (in the extreme, report
      // `consumed === 0` while `converted > 0`), making `residual` equal to the ENTIRE original
      // amount even though that amount already bought target units elsewhere — double-booking the
      // source amount (once implicitly backing the converted target units, once again as
      // "unconvertible" residual). See the concrete reproduction below for a minimal case.
      it("residual can never buy another whole target unit if it were converted again (rules out an under-counted `consumed`)", () => {
        fc.assert(
          fc.property(
            fc.bigInt({ min: 1n, max: 10n ** 30n }),
            fc.integer({ min: 0, max: 18 }),
            fc.integer({ min: 0, max: 18 }),
            fc.bigInt({ min: 1n, max: 10n ** 12n }),
            fc.bigInt({ min: 1n, max: 10n ** 12n }),
            (amount, fromDecimals, toDecimals, rateNum, rateDen) => {
              const { residual } = convert(
                amount.toString(),
                fromDecimals,
                toDecimals,
                rateNum.toString(),
                rateDen.toString(),
              );

              const scaleDiff = toDecimals - fromDecimals;
              const scaleFactor = 10n ** BigInt(Math.abs(scaleDiff));
              const rateNumerator = scaleDiff >= 0 ? rateNum * scaleFactor : rateNum;
              const rateDenominator = scaleDiff >= 0 ? rateDen : rateDen * scaleFactor;

              // Running the reported residual back through the SAME conversion must buy zero
              // more whole target units, or it was not genuine dust.
              const additionalTargetUnits = (BigInt(residual) * rateNumerator) / rateDenominator;

              return additionalTargetUnits === 0n;
            },
          ),
          { numRuns: 2000 },
        );
      });

      // A minimal, concrete demonstration of exactly what a floor-based `consumed` would get
      // wrong (this passes today because convert() uses ceilDiv; it is a tripwire against
      // reintroducing plain `/` here): 1 whole unit (0 decimals) converted to 1-decimal units at
      // rate 1/3 produces 3 target minor units, and none of the source amount is left over.
      it("converting 1 unit at rate 1/3 (0dp -> 1dp) fully consumes the source amount (consumed === amount, residual === 0)", () => {
        const { amount, residual } = convert("1", 0, 1, "1", "3");
        expect(amount).toBe("3");
        // A floor-based `consumed` (floor(3*3/10) = 0) would wrongly report residual = "1" here —
        // the entire source amount — despite it already having bought 3 target units.
        expect(residual).toBe("0");
      });
    });

    // --- Regression tests for the pre-2026-09-06 unit-confusion bug ------------------------------

    it("REGRESSION (upscale): residual is in SOURCE minor units, not the old target-fraction unit that would break Σdebits=Σcredits", () => {
      // USD (2dp) -> USDX (3dp) at rate 1/23, $0.04 -> upscale.
      // Hand-derived: converted = floor(4*10/23) = 1, consumed = ceilDiv(1*23, 10) = 3, so the
      // postable residual (in source cents) must be 1 (4 - 3).
      //
      // The OLD implementation returned `totalNumerator % totalDenominator` = (4*10) % 23 = 17.
      // If that "17" were journaled as source cents, consumed(3) + residual(17) = 20 !== amount(4):
      // the FX pair would not balance, and 17 > amount itself — a physically impossible "dust".
      // This is exactly the bug ADR-0015 fixes for the upscale direction, and it would NOT have
      // been caught by either pre-existing convert() test (both use rate 1/1, where old and new
      // formulas happen to coincide).
      const { amount, residual } = convert("4", 2, 3, "1", "23");
      expect(amount).toBe("1");
      expect(residual).toBe("1");

      const oldBuggyResidual = (4n * 10n) % 23n;
      expect(oldBuggyResidual.toString()).not.toBe(residual);
      expect(oldBuggyResidual > 4n).toBe(true); // proves the old value was not even a valid amount
    });

    it("downscale with a coprime non-unit rate (7/3): USDX (6dp) -> USD (2dp)", () => {
      // 100.000123 USDX -> USD, rate 7/3.
      const { amount, residual } = convert("100000123", 6, 2, "7", "3");
      expect(amount).toBe("23333");
      expect(residual).toBe("1551");
      // Postability: consumed (ceilDiv(converted worth back in source units)) + residual ===
      // amountMinor. rateNumerator=7, rateDenominator=3*10000=30000 for this 6dp->2dp downscale.
      const numerator = BigInt(amount) * 30000n;
      const consumed = (numerator + 7n - 1n) / 7n;
      expect(consumed + BigInt(residual)).toBe(100000123n);
    });

    it("upscale with a coprime non-unit rate (1/3): USD (2dp) -> USDX (6dp)", () => {
      const { amount, residual } = convert("100", 2, 6, "1", "3");
      // converted = floor(100*10000/3) = 333333; consumed = ceilDiv(333333*3, 10000) = 100;
      // residual = 100 - 100 = 0 — the whole amount is exactly, evenly consumed here.
      expect(amount).toBe("333333");
      expect(residual).toBe("0");
    });

    it("equal scales (fromDecimals === toDecimals) with a non-unit rate produces exact consumption (no residual) for this input", () => {
      const { amount, residual } = convert("1000", 2, 2, "5", "7");
      // converted = floor(1000*5/7) = 714; consumed = ceilDiv(714*7, 5) = 1000; residual = 0.
      expect(amount).toBe("714");
      expect(residual).toBe("0");
    });

    it("equal scales (fromDecimals === toDecimals) with a non-unit rate CAN produce a non-zero residual", () => {
      // amount=6, rate 1/23, equal scale (both 2dp): converted = floor(6/23) = 0,
      // consumed = ceilDiv(0*23, 1) = 0, residual = 6 (nothing could be bought at all).
      const { amount, residual } = convert("6", 2, 2, "1", "23");
      expect(amount).toBe("0");
      expect(residual).toBe("6");
    });

    // --- The new decimals guard, mirroring `assets` table's CHECK (decimals BETWEEN 0 AND 18) ----

    describe("decimals guard", () => {
      it.each([
        ["fromDecimals", -1, 6],
        ["fromDecimals", 19, 6],
        ["fromDecimals", 2.5, 6],
        ["toDecimals", 2, -1],
        ["toDecimals", 2, 19],
        ["toDecimals", 2, 2.5],
      ])("rejects out-of-range or non-integer %s (from=%p, to=%p)", (_label, from, to) => {
        expect(() => convert("100", from, to, "1", "1")).toThrow();
      });

      it("accepts the boundary values 0 and 18 for both decimals", () => {
        expect(() => convert("100", 0, 18, "1", "1")).not.toThrow();
        expect(() => convert("100", 18, 0, "1", "1")).not.toThrow();
      });

      // Catches: `Number.isInteger` being applied to a value that has already been coerced through
      // something like `Number(decimals)`, which would turn a non-numeric string into NaN and pass
      // silently through a loose `NaN > 18` check (NaN comparisons are always false).
      it("rejects NaN decimals rather than silently treating them as in-range", () => {
        expect(() => convert("100", NaN, 6, "1", "1")).toThrow();
      });
    });

    // --- Boundary and malformed input -------------------------------------------------------------

    describe("boundary and malformed input", () => {
      it("returns zero amount and zero residual for a zero amountMinor", () => {
        const { amount, residual } = convert("0", 2, 6, "1", "1");
        expect(amount).toBe("0");
        expect(residual).toBe("0");
      });

      // Catches: overflow or precision loss when amountMinor sits at the edge of what
      // numeric(38,0) can hold — a naive implementation using Number anywhere in the path
      // would silently lose precision here instead of throwing or computing correctly.
      it("handles an amount at the numeric(38,0) boundary (38 nines) without precision loss", () => {
        const thirtyEightNines = "9".repeat(38);
        const { amount, residual } = convert(thirtyEightNines, 2, 2, "1", "1");
        expect(amount).toBe(thirtyEightNines);
        expect(residual).toBe("0");
      });

      it("throws on a non-numeric amountMinor string", () => {
        expect(() => convert("not-a-number", 2, 6, "1", "1")).toThrow();
      });

      // Was a finding from the adversarial pass: `BigInt("")` and `BigInt("   ")` both evaluate
      // to `0n`, so before toMinor() a webhook with a missing or blank amount posted a
      // legitimate-looking zero-value leg instead of failing. Fixed 2026-09-06; these lock it in.
      it.each([["   "], [""], ["1.5"], ["1e3"], ["0x10"], ["100 "]])(
        "throws on a malformed amountMinor rather than coercing it (%p)",
        (malformed) => {
          expect(() => convert(malformed, 2, 6, "1", "1")).toThrow(/integer string in minor units/);
        },
      );

      it("throws on a negative amountMinor", () => {
        expect(() => convert("-100", 2, 6, "1", "1")).toThrow();
      });

      it("throws on a zero exchange rate numerator", () => {
        expect(() => convert("100", 2, 6, "0", "1")).toThrow();
      });

      it("throws on a negative exchange rate numerator", () => {
        expect(() => convert("100", 2, 6, "-1", "1")).toThrow();
      });

      it("throws on a zero exchange rate denominator", () => {
        expect(() => convert("100", 2, 6, "1", "0")).toThrow();
      });

      it("throws on a negative exchange rate denominator", () => {
        expect(() => convert("100", 2, 6, "1", "-1")).toThrow();
      });

      // Catches: an implementation that special-cases the trivial "no scale change, rate 1/1"
      // path and skips the negative-amount / rate validation checks entirely.
      it("still validates rate/amount even when fromDecimals === toDecimals and rate is 1/1", () => {
        expect(() => convert("-1", 5, 5, "1", "1")).toThrow();
        expect(() => convert("1", 5, 5, "0", "1")).toThrow();
      });
    });
  });
});
