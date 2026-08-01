// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Deploy — deterministic local deployment for the demo stack.
/// @dev TODO(Phase 2):
///        - vm.startBroadcast()
///        - deploy StableUSD (6 decimals, symbol USDX)
///        - deploy PaymentProcessor(stableUsd)
///        - configureMinter(treasury, INITIAL_MINTER_ALLOWANCE)  — a SAFETY LIMIT, sized
///          deliberately, not "large enough to never think about"
///        - grant OPERATOR_ROLE on PaymentProcessor to the hot_payout account
///        - mint the initial treasury float (see ADR-0013: settlement transfers from a FINITE
///          treasury; it does not mint per payment)
///        - vm.stopBroadcast()
///        - write {chainId, stableUsd, paymentProcessor, deployBlock} to the shared volume as
///          addresses.local.json, consumed by packages/shared/src/addresses.ts
contract DeployScript {}
