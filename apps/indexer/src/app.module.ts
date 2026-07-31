import { Module } from "@nestjs/common";

/**
 * Root module.
 *
 * TODO(Phase 1+): wire up feature modules as they land:
 *   - ConfigModule (env: chain, db, observability)
 *   - TypeOrmModule.forRoot(...) using src/blockchain/data-source.ts options
 *   - ScheduleModule.forRoot()  (5s indexer tick)
 *   - BlockchainModule  (core engine + event registry + handlers)
 *   - ApiModule         (read endpoints)
 *   - AdminModule       (replay / catch-up, guarded)
 *   - ObservabilityModule (Prometheus, metrics service, pino logger)
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}
