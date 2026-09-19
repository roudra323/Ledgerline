// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PaymentProcessor — settlement, refund and payout routing for StableUSD.
/// @notice A conduit, never a vault. It holds no balance between transactions.
/// @dev    TODO(Part 2): implement.
///
///         struct Payment { address merchant; uint256 amount; uint256 fee; uint256 refunded; bool exists; }
///         mapping(bytes32 => Payment) public payments;
///         mapping(bytes32 => bool)    public payoutRequested;
///
///         settle(bytes32 paymentId, address merchant, uint256 amount)          OPERATOR
///         settleWithAuthorization(..., Authorization calldata auth)            EIP-3009 path
///         refund(bytes32 paymentId, uint256 amount)                            OPERATOR
///         requestPayout(bytes32 payoutId, uint256 amount)                      merchant
///         setFeeBps / setFeeRecipient                                          ADMIN
///         pause / unpause                                                      PAUSER
///
///         TWO LOAD-BEARING ON-CHAIN INVARIANTS (docs/decisions/0009-on-chain-vs-off-chain.md).
///         These are the only things standing between a server bug and a double payment:
///
///           1. settle() reverts PaymentAlreadySettled if payments[id].exists.
///              A duplicate submission from a crashed-and-restarted submitter can never
///              double-pay a merchant. Off-chain idempotency is defence-in-depth ON TOP of this,
///              not the primary mechanism.
///
///           2. refunded + amount <= payments[id].amount, else RefundExceedsCapture.
///              Partial-refund overrun is impossible even if every off-chain check is wrong.
///
///         Events carry amount + fee + resulting total, so off-chain handlers are self-contained
///         and deterministic under replay. Keep it.
///
///         FEE: the platform fee is taken OFF-CHAIN, in USD, by the ledger's onramp.fx posting
///         (docs/decisions/0018-ledger-flow-postings.md). settle() is called with the merchant's
///         NET amount and feeBps stays 0; the fee/netAmount event fields remain so the event shape
///         is stable if that is ever revisited. Charging a fee here as well would take it twice.
///
///         TODO(Part 2) invariant suite (PaymentProcessor.invariants.t.sol):
///           - token.balanceOf(address(this)) == 0 after every action  (conduit, never a vault —
///             one line that kills a whole class of stuck-funds bugs)
///           - forall id: payments[id].refunded <= payments[id].amount
///           - payments[id].exists is monotone false -> true
///           - sum(PaymentSettled.netAmount) - sum(PaymentRefunded.amount)
///               == sum(net token delta of merchants)     (a Solidity-level trial balance)
///           - feeBps <= MAX_FEE_BPS always
contract PaymentProcessor {
    /* -------------------------------------------------------------- events */

    event PaymentSettled(
        bytes32 indexed paymentId,
        address indexed merchant,
        address indexed payer,
        uint256 amount,
        uint256 fee,
        uint256 netAmount
    );
    event PaymentRefunded(bytes32 indexed paymentId, address indexed merchant, uint256 amount, uint256 totalRefunded);
    event PayoutRequested(bytes32 indexed payoutId, address indexed merchant, uint256 amount);
    event FeeConfigChanged(uint16 feeBps, address feeRecipient);

    /* -------------------------------------------------------------- errors */

    error PaymentAlreadySettled(bytes32 paymentId);
    error UnknownPayment(bytes32 paymentId);
    error RefundExceedsCapture(bytes32 paymentId, uint256 requested, uint256 remaining);
    error PayoutAlreadyRequested(bytes32 payoutId);
    error ZeroAmount();
    error ProcessorPaused();
}
