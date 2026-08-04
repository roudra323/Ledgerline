import type { AmountMinor } from "@ledgerline/shared";

/**
 * Money utilities for integer minor unit arithmetic.
 *
 * Money is ALWAYS represented as a decimal string of an integer minor unit (e.g. cents, wei).
 * JavaScript `number` is forbidden for monetary values to eliminate floating-point rounding errors.
 */

/**
 * Adds two minor unit amounts (must be of the same asset).
 */
export function add(a: AmountMinor, b: AmountMinor): AmountMinor {
  const sum = BigInt(a) + BigInt(b);
  return sum.toString();
}

/**
 * Subtracts minor unit amount `b` from `a` (must be of the same asset).
 * Throws if result is negative (money values cannot be negative).
 */
export function sub(a: AmountMinor, b: AmountMinor): AmountMinor {
  const diff = BigInt(a) - BigInt(b);
  if (diff < 0n) {
    throw new Error(`Negative money value resulting from subtraction: ${a} - ${b}`);
  }
  return diff.toString();
}

/**
 * Returns true if amount is zero ("0").
 */
export function isZero(a: AmountMinor): boolean {
  return BigInt(a) === 0n;
}

/**
 * Compares two minor unit amounts.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compare(a: AmountMinor, b: AmountMinor): number {
  const valA = BigInt(a);
  const valB = BigInt(b);
  if (valA < valB) return -1;
  if (valA > valB) return 1;
  return 0;
}

/**
 * Splits an amount into a platform fee and net merchant payout using basis points (bps).
 *
 * Fee is calculated using floor division: fee = floor(amount * bps / 10000).
 * Net is derived by subtraction: net = amount - fee.
 * By derivation, fee + net === amount IS ALWAYS GUARANTEED (no cents lost or created).
 */
export function splitFee(
  amountMinor: AmountMinor,
  bps: number,
): { fee: AmountMinor; net: AmountMinor } {
  if (bps < 0 || bps > 10000) {
    throw new Error(`Basis points (bps) must be between 0 and 10000. Received: ${bps}`);
  }

  const amount = BigInt(amountMinor);
  if (amount < 0n) {
    throw new Error(`Amount cannot be negative: ${amountMinor}`);
  }

  const fee = (amount * BigInt(bps)) / 10000n;
  const net = amount - fee;

  return {
    fee: fee.toString(),
    net: net.toString(),
  };
}

/**
 * Converts an amount from one asset/decimal scale to another using an exchange rate (rateNum / rateDen).
 * Returns the converted amount and any leftover residual (rounding dust) that could not be converted.
 *
 * Residual is returned so it can be journaled to a rounding_residual ledger account.
 */
export function convert(
  amountMinor: AmountMinor,
  fromDecimals: number,
  toDecimals: number,
  rateNum: AmountMinor,
  rateDen: AmountMinor,
): { amount: AmountMinor; residual: AmountMinor } {
  const amount = BigInt(amountMinor);
  const num = BigInt(rateNum);
  const den = BigInt(rateDen);

  if (amount < 0n) {
    throw new Error(`Amount cannot be negative: ${amountMinor}`);
  }
  if (num <= 0n) {
    throw new Error(`Exchange rate numerator must be positive: ${rateNum}`);
  }
  if (den <= 0n) {
    throw new Error(`Exchange rate denominator must be positive: ${rateDen}`);
  }

  const scaleDiff = toDecimals - fromDecimals;
  let totalNumerator: bigint;
  let totalDenominator: bigint;

  if (scaleDiff >= 0) {
    const scaleFactor = 10n ** BigInt(scaleDiff);
    totalNumerator = amount * num * scaleFactor;
    totalDenominator = den;
  } else {
    const scaleFactor = 10n ** BigInt(-scaleDiff);
    totalNumerator = amount * num;
    totalDenominator = den * scaleFactor;
  }

  const converted = totalNumerator / totalDenominator;
  const residual = totalNumerator % totalDenominator;

  return {
    amount: converted.toString(),
    residual: residual.toString(),
  };
}
