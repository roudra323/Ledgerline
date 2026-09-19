/**
 * LogFetcher — pulls logs for a block range via ChainClient.getLogs.
 *
 * TODO(Part 4): fixed chunk size fetch.
 * TODO(Part 4): delegate sizing to AdaptiveChunker (halve on "range too large", floor 1,
 *   multiplicative recovery). Records ledgerline_chunk_size and ledgerline_rpc_* metrics.
 */

export {};
