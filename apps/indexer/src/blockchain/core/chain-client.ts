/**
 * ChainClient — viem public client wrapper.
 *
 * TODO(Phase 1): single-transport public client (http(RPC_URL_PRIMARY)).
 * TODO(Phase 2): swap to viem `fallback([primary, fallback])` for RPC failover; expose
 *   provider health so the RPC metrics (chainstake_rpc_*) can be emitted.
 *
 * Responsibilities: getBlockNumber(), getBlock(hash|number), getLogs(range, address, events),
 *   readContract(totalStaked) for the reconciliation audit.
 */

export {};
