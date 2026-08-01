// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title StableUSD (USDX) — a FiatToken-shaped issuer stablecoin.
/// @notice Modelled on Circle's FiatToken: 6 decimals, minter allowances, blacklist, pause,
///         EIP-2612 permit and EIP-3009 authorized transfers.
/// @dev    TODO(Phase 2): implement. Roles via OZ AccessControl:
///           DEFAULT_ADMIN_ROLE, MASTER_MINTER_ROLE, MINTER_ROLE, PAUSER_ROLE, BLACKLISTER_ROLE
///
///         Interface (see docs/build-plan.md Part 1.1):
///           configureMinter / removeMinter          (MASTER_MINTER)
///           mint / burn                             (MINTER, mint <= allowance)
///           blacklist / unBlacklist / isBlacklisted (BLACKLISTER)
///           pause / unpause                         (PAUSER)
///           permit                                  (EIP-2612)
///           transferWithAuthorization               (EIP-3009)
///           receiveWithAuthorization                (EIP-3009 — REQUIRES msg.sender == to)
///           cancelAuthorization / authorizationState
///
///         Merchant payments MUST use `receiveWithAuthorization`, never
///         `transferWithAuthorization`: the latter can be front-run by anyone who sees the signed
///         authorization in the mempool, which grief-fails the intended relayer's transaction and
///         desynchronizes the saga. `receiveWithAuthorization` requires msg.sender == to, so only
///         PaymentProcessor can execute it.
///
///         TODO(Phase 2) invariant suite (StableUSD.invariants.t.sol), bounded handler:
///           - sumOfTrackedBalances == totalSupply()
///           - totalSupply() == ghost_totalMinted - ghost_totalBurned
///           - ghost_mintedByMinter[m] <= ghost_allowanceGrantedTo[m]  (across a sequence)
///           - paused => no balance changed since the pause
///           - isBlacklisted(a) => balanceOf(a) unchanged since blacklisting
///           - authorizationState(a, n) is monotone false -> true, and never returns
///           - decimals() == 6   (catches a refactor that would silently 10^12 every amount)
contract StableUSD {
    /* -------------------------------------------------------------- events */

    event Mint(address indexed minter, address indexed to, uint256 amount);
    event Burn(address indexed burner, uint256 amount);
    event MinterConfigured(address indexed minter, uint256 allowance);
    event MinterRemoved(address indexed minter);
    event Blacklisted(address indexed account);
    event UnBlacklisted(address indexed account);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    event Pause();
    event Unpause();

    /* -------------------------------------------------------------- errors */

    error NotMinter(address caller);
    error ExceedsMinterAllowance(uint256 requested, uint256 allowance);
    error AccountBlacklisted(address account);
    error TokenPaused();
    error AuthorizationAlreadyUsed(bytes32 nonce);
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error InvalidSignature();
    error CallerMustBePayee();
}
