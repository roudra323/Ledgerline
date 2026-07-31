/**
 * AdaptiveChunker — owns the current chunk size per sync_key.
 *
 * TODO(Phase 2):
 *   - shrink(): halve on too-large / rate-limit errors, floor at 1.
 *   - grow(): multiplicative recovery toward INDEXER_START_CHUNK_SIZE on sustained success.
 *   - current size is exported as chainstake_chunk_size{sync_key} (a provider-health proxy).
 */

export {};
