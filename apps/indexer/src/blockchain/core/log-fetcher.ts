/**
 * LogFetcher — pulls logs for a block range via ChainClient.getLogs.
 *
 * TODO(Phase 1): fixed chunk size fetch.
 * TODO(Phase 2): delegate sizing to AdaptiveChunker (halve on "range too large", floor 1,
 *   multiplicative recovery). Records ledgerline_chunk_size and ledgerline_rpc_* metrics.
 */

export {};
