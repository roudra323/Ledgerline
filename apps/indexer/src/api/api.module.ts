import { Module } from "@nestjs/common";

/**
 * ApiModule — public read endpoints (Phase 1+):
 *   GET /users/:address/balance
 *   GET /users/:address/history
 *   GET /stats                 (TVL, stakers count)
 *   GET /health/indexer        (lag, cursor positions)
 *
 * TODO(Phase 1): register controllers + query services (read from projections only).
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class ApiModule {}
