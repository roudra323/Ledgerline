/**
 * LogFetcher — pulls logs for a block range via ChainClient.getLogs.
 *
 * TODO(Phase 1): fixed chunk size fetch.
 * TODO(Phase 2): delegate sizing to AdaptiveChunker (halve on "range too large", floor 1,
 *   multiplicative recovery). Records chainstake_chunk_size and chainstake_rpc_* metrics.
 */

export {};
