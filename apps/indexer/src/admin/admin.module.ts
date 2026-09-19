import { Module } from "@nestjs/common";

/**
 * AdminModule — guarded operational endpoints (Part 4):
 *   POST /admin/replay  { projections: [...] }   — rebuild projections from both logs
 *   POST /admin/catchup { syncKey }               — trigger a catch-up run
 *
 * TODO(Part 4): register ReplayService + AdminController behind an auth/admin guard.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AdminModule {}
