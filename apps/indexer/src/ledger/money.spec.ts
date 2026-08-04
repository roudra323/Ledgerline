import * as fc from "fast-check";

import { add, compare, convert, isZero, splitFee, sub } from "./money";

describe("money utilities", () => {
  describe("add", () => {
    it("adds two minor unit amounts correctly", () => {
      expect(add("100", "200")).toBe("300");
      expect(add("0", "50")).toBe("50");
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
  });

  describe("isZero & compare", () => {
    it("identifies zero correctly", () => {
      expect(isZero("0")).toBe(true);
      expect(isZero("100")).toBe(false);
    });

    it("compares amounts correctly", () => {
      expect(compare("100", "200")).toBe(-1);
      expect(compare("200", "100")).toBe(1);
      expect(compare("100", "100")).toBe(0);
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
  });
});
