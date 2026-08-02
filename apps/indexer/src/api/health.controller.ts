import { Controller, Get } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";

/**
 * HealthController — GET /health: liveness + database reachability.
 *
 * db reflects a real SELECT 1, not a cached flag — a dying database shows up here
 * before it shows up anywhere else. Status stays "ok" while the DB is down: a 200
 * with an explicit db flag beats a 503 that a load balancer might mistake for a
 * restart. The sagas park; the process does not exit.
 *
 * TODO(Phase 5): shape as { block, lagBlocks, lagSeconds, syncKeys: [...] } and move
 * to /health/indexer once the indexer cursors exist.
 */
@Controller("health")
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async check(): Promise<{ status: "ok"; db: "up" | "down" }> {
    let db: "up" | "down" = "down";
    try {
      await this.dataSource.query("SELECT 1");
      db = "up";
    } catch {
      // DB unreachable — health must still return, not throw.
    }
    return { status: "ok", db };
  }
}
