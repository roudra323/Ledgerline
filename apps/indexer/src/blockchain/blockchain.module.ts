/**
 * BlockchainModule — on-chain ingest. One of the two source-of-truth logs.
 *
 * The inherited event-sourced core, unchanged in shape: single parameterized runChunk() loop,
 * adaptive chunking, per-key cursors, reorg guard, failure isolation, replay.
 *
 * TODO(Part 4): re-point handlers at the payment contracts and apply the partial-unique-index
 * fix from docs/decisions/0010-raw-events-partial-unique.md.
 */

export {};
