/**
 * ChainWriterModule — the chain write path (docs/decisions/0006-chain-write-path.md).
 *
 * The single most correctness-critical component in the system. The invariant:
 *   sign and persist the raw transaction BEFORE broadcasting.
 * Recovery after a crash at any point is then uniformly "re-broadcast every attempt whose parent
 * isn't confirmed" — and `already known` / `nonce too low` are SUCCESS signals, not errors.
 *
 * TODO(Phase 3):
 *   - entities: ChainAccount, ChainTransaction, ChainTxAttempt, ChainFingerprint.
 *   - SignerPort + LocalDevSigner (boot-crashes unless NODE_ENV !== 'production' && chainId 31337).
 *   - KmsSigner: DER -> (r,s), normalize s to low half-order per EIP-2, recover v. Unit-tested
 *     against fixtures; never run in the demo.
 *   - SigningPolicyService: value caps, `to` allowlist, function-selector allowlist per role,
 *     chain-id pinning, is_frozen kill switch. Writes a signing_requests audit row every time.
 *   - ChainTxSubmitter: simulate -> row-lock nonce -> sign -> persist -> COMMIT -> broadcast.
 *     Gas escalation escalates ONLY MIN(nonce) — never bump a later tx to fill a hole.
 *   - ChainTxWatcher: polls receipts. Updates chain_transactions ONLY. Never advances a saga
 *     except toward compensation on a revert (docs/decisions/0007-events-not-receipts.md).
 */

export {};
