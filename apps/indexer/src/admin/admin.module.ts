import { Module } from "@nestjs/common";

/**
 * AdminModule — guarded operational endpoints (Phase 2):
 *   POST /admin/replay  { projections: [...] }   — rebuild projections from raw_events
 *   POST /admin/catchup { syncKey }               — trigger a catch-up run
 *
 * TODO(Phase 2): register ReplayService + AdminController behind an auth/admin guard.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AdminModule {}
