/**
 * ChainClient — the viem public client.
 *
 * TODO(Part 4): createPublicClient with fallback([primary, secondary]) so a provider outage is
 *   survivable; wrap calls to emit ledgerline_rpc_* metrics per provider.
 *
 * TODO(Part 11): the second provider is NOT decoration. Before any irreversible fiat action the
 *   confirming block hash is cross-checked against it; disagreement holds the payout and fires
 *   RpcDisagreement (failure mode B10). If that check is ever cut, cut anvil2 from compose too.
 */

export {};
