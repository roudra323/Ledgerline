import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { TypeOrmModule } from "@nestjs/typeorm";

import { HealthController } from "./api/health.controller";
import { ConfigModule } from "./config/config.module";
import { appDataSourceOptions } from "./data-source";
import { LedgerModule } from "./ledger/ledger.module";
import { ObservabilityModule } from "./observability/observability.module";

/**
 * Root module.
 *
 * Wired phase by phase. The order below is the dependency order, not a wish list:
 *   ConfigModule                     env, validated at boot — bad config CRASHES, never defaults
 *   TypeOrmModule.forRoot()          from src/data-source.ts
 *   ScheduleModule.forRoot()         indexer tick, outbox poll, reconciler crons
 *   ObservabilityModule              Prometheus, metrics, pino  (Phase 0/7)
 *   LedgerModule                     the only writer of ledger_entries  (Phase 1)
 *   ChainWriterModule                signer, policy, submitter, watcher (Phase 3)
 *   BlockchainModule                 on-chain ingest + handlers         (Phase 4)
 *   OutboxModule                     transactional outbox               (Phase 5)
 *   FiatModule                       off-chain ingest + PSP adapters    (Phase 5)
 *   SagasModule                      on-ramp / refund / payout          (Phase 6, 8, 9)
 *   ComplianceModule                 screening gates                    (Phase 10)
 *   ApiModule                        read endpoints (projections only)  (Phase 6)
 *   AdminModule                      replay, reconciliation, operator commands
 *
 * TODO(Part 4): the boot sequence must FAIL LOUD on: missing/invalid config, a duplicate or
 * unknown event handler, a `placeholder: true` addresses file, and a chain_fingerprint mismatch
 * (failure mode B6). Config errors crash at startup; only runtime per-event errors isolate.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRoot(appDataSourceOptions),
    ScheduleModule.forRoot(),
    ObservabilityModule,
    LedgerModule,
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
