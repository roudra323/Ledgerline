/**
 * Shared domain types. Kept deliberately small — this package is the cross-workspace contract,
 * not a dumping ground.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/**
 * Every amount in this system is an integer in the MINOR UNIT of a named asset, carried as a
 * string. Never a JS `number`. See docs/decisions/0001-money-representation.md.
 */
export type AmountMinor = string;

export type AssetCode = "USD" | "USDX" | "ETH";
export type AssetKind = "fiat" | "token" | "native";

export interface Asset {
  readonly code: AssetCode;
  readonly kind: AssetKind;
  /** Scale belongs to the asset, never to a row. */
  readonly decimals: number;
}

export type ContractName = "StableUSD" | "PaymentProcessor";

/** Events the indexer registers handlers for. Must match the ABIs in ./abis. */
export type StableUsdEventName =
  | "Transfer"
  | "Mint"
  | "Burn"
  | "MinterConfigured"
  | "MinterRemoved"
  | "Blacklisted"
  | "UnBlacklisted"
  | "AuthorizationUsed"
  | "Pause"
  | "Unpause";

export type PaymentProcessorEventName =
  "PaymentSettled" | "PaymentRefunded" | "PayoutRequested" | "FeeConfigChanged";

export type OnChainEventName = StableUsdEventName | PaymentProcessorEventName;

export interface DeployedAddresses {
  readonly chainId: number;
  readonly stableUsd: Address;
  readonly paymentProcessor: Address;
  readonly deployBlock: number;
}
