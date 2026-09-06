import type { AmountMinor } from "@ledgerline/shared";

/**
 * Money utilities for integer minor unit arithmetic.
 *
 * Money is ALWAYS represented as a decimal string of an integer minor unit (e.g. cents, wei).
 * JavaScript `number` is forbidden for monetary values to eliminate floating-point rounding errors.
 */

/**
 * Parses a minor-unit amount, rejecting anything that is not a plain integer string.
 *
 * `BigInt("")` and `BigInt("   ")` both evaluate to `0n` — so without this guard a webhook whose
 * amount field is missing or blank posts a legitimate-looking zero-value leg instead of failing.
 * A money value that quietly becomes zero is worse than one that throws (golden rule 7: fail loud).
 */
function toMinor(value: AmountMinor, label: string): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(
      `${label} must be an integer string in minor units, got ${JSON.stringify(value)}`,
    );
  }
  return BigInt(value);
}

/**
 * Adds two minor unit amounts (must be of the same asset).
 */
export function add(a: AmountMinor, b: AmountMinor): AmountMinor {
  const sum = toMinor(a, "a") + toMinor(b, "b");
  return sum.toString();
}

/**
 * Subtracts minor unit amount `b` from `a` (must be of the same asset).
 * Throws if result is negative (money values cannot be negative).
 */
export function sub(a: AmountMinor, b: AmountMinor): AmountMinor {
  const diff = toMinor(a, "a") - toMinor(b, "b");
  if (diff < 0n) {
    throw new Error(`Negative money value resulting from subtraction: ${a} - ${b}`);
  }
  return diff.toString();
}

/**
 * Returns true if amount is zero ("0").
 */
export function isZero(a: AmountMinor): boolean {
  return toMinor(a, "a") === 0n;
}

/**
 * Compares two minor unit amounts.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compare(a: AmountMinor, b: AmountMinor): number {
  const valA = toMinor(a, "a");
  const valB = toMinor(b, "b");
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

  const amount = toMinor(amountMinor, "amountMinor");
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
 * The scale bounds `assets.decimals` enforces (`CHECK (decimals BETWEEN 0 AND 18)`). Mirrored here
 * because `10n ** BigInt(huge)` would otherwise hang rather than throw.
 */
const MIN_ASSET_DECIMALS = 0;
const MAX_ASSET_DECIMALS = 18;

/**
 * Converts an amount from one asset's scale to another at an exchange rate of `rateNum / rateDen`.
 *
 * Returns the converted amount **and the dust the conversion could not carry**, so the caller can
 * journal that dust to `3900 rounding_residual` rather than dropping it. Silently discarded dust is
 * exactly what makes a trial balance drift (ADR-0001, docs/conventions.md §9.1).
 *
 * `residual` is an amount in the **SOURCE** asset's minor units — the part of `amountMinor` that
 * was too small to buy another whole minor unit of the target asset. It is a real amount in a named
 * asset, which is what makes it postable: `residual` journals to `3900 rounding_residual` in the
 * source asset, and `amountMinor === consumed + residual` always holds, so the FX pair balances on
 * both sides.
 *
 * (Before 2026-09-06 this returned `totalNumerator % totalDenominator`, whose unit silently changed
 * with the direction of the scale change — source minor units when downscaling, but a fraction of a
 * target minor unit when upscaling. That value was unpostable in one of the two directions. See
 * ADR-0015.)
 */
export function convert(
  amountMinor: AmountMinor,
  fromDecimals: number,
  toDecimals: number,
  rateNum: AmountMinor,
  rateDen: AmountMinor,
): { amount: AmountMinor; residual: AmountMinor } {
  const amount = toMinor(amountMinor, "amountMinor");
  const num = toMinor(rateNum, "rateNum");
  const den = toMinor(rateDen, "rateDen");

  if (amount < 0n) {
    throw new Error(`Amount cannot be negative: ${amountMinor}`);
  }
  if (num <= 0n) {
    throw new Error(`Exchange rate numerator must be positive: ${rateNum}`);
  }
  if (den <= 0n) {
    throw new Error(`Exchange rate denominator must be positive: ${rateDen}`);
  }
  assertAssetDecimals(fromDecimals, "fromDecimals");
  assertAssetDecimals(toDecimals, "toDecimals");

  // Fold the scale change into the rate, so the conversion is one rational multiply in either
  // direction: target = floor(source * rateNumerator / rateDenominator).
  const scaleDiff = toDecimals - fromDecimals;
  const scaleFactor = 10n ** BigInt(Math.abs(scaleDiff));
  const rateNumerator = scaleDiff >= 0 ? num * scaleFactor : num;
  const rateDenominator = scaleDiff >= 0 ? den : den * scaleFactor;

  const converted = (amount * rateNumerator) / rateDenominator;

  // The SMALLEST source amount that still yields `converted` — a ceiling, not a floor. Flooring
  // here undershoots whenever the rate does not divide evenly: converting the floored value back
  // lands on `converted - 1`, so the dust would be overstated by the source units that were in fact
  // spent. Whatever `amount` has beyond `consumed` genuinely could not buy another target unit.
  const consumed = ceilDiv(converted * rateDenominator, rateNumerator);

  return {
    amount: converted.toString(),
    residual: (amount - consumed).toString(),
  };
}

/** Ceiling division for positive integers — bigint `/` truncates toward zero. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** Guards a scale against the same bounds the `assets` table enforces. */
function assertAssetDecimals(decimals: number, label: string): void {
  if (
    !Number.isInteger(decimals) ||
    decimals < MIN_ASSET_DECIMALS ||
    decimals > MAX_ASSET_DECIMALS
  ) {
    throw new Error(
      `${label} must be an integer between ${MIN_ASSET_DECIMALS} and ${MAX_ASSET_DECIMALS}, got ${decimals}`,
    );
  }
}
