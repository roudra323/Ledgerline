// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Deploy — deterministic local deployment for the demo stack.
/// @dev TODO(Part 2):
///        - vm.startBroadcast()
///        - deploy StableUSD (6 decimals, symbol USDX)
///        - deploy PaymentProcessor(stableUsd)
///        - configureMinter(treasury, INITIAL_MINTER_ALLOWANCE)  — a SAFETY LIMIT, sized
///          deliberately, not "large enough to never think about"
///        - grant OPERATOR_ROLE on PaymentProcessor to the hot_payout account
///        - mint the initial treasury float (see ADR-0013: settlement transfers from a FINITE
///          treasury; it does not mint per payment). The ledger must journal this genesis mint as
///          `treasury.mint` (DR 1100 / CR 2500, ADR-0018) or invariants I3 and I4 fail from block 0
///        - vm.stopBroadcast()
///        - write {chainId, stableUsd, paymentProcessor, deployBlock} to the shared volume as
///          addresses.local.json, consumed by packages/shared/src/addresses.ts
contract DeployScript {}
