import { Module } from "@nestjs/common";

/**
 * BlockchainModule — the indexing engine.
 *
 * TODO(Phase 1): register providers:
 *   ChainClient, LogFetcher, SyncStateService, IndexerService,
 *   EventRegistryService, StakedHandler, WithdrawnHandler,
 *   and TypeOrmModule.forFeature([...entities]).
 * TODO(Phase 2): ReorgGuardService, AdaptiveChunker, ReconciliationService, retry job.
 */
@Module({
  imports: [],
  providers: [],
  exports: [],
})
export class BlockchainModule {}
