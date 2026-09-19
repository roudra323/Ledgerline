/**
 * AdaptiveChunker — owns the current chunk size per sync_key.
 *
 * TODO(Part 4):
 *   - shrink(): halve on too-large / rate-limit errors, floor at 1.
 *   - grow(): multiplicative recovery toward INDEXER_START_CHUNK_SIZE on sustained success.
 *   - current size is exported as ledgerline_chunk_size{sync_key} (a provider-health proxy).
 */

export {};
