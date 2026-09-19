import { Controller, Get, Logger } from "@nestjs/common";
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
 * TODO(Part 4): shape as { block, lagBlocks, lagSeconds, syncKeys: [...] } and move
 * to /health/indexer once the indexer cursors exist.
 */
@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async check(): Promise<{ status: "ok"; db: "up" | "down" }> {
    let db: "up" | "down" = "down";
    try {
      await this.dataSource.query("SELECT 1");
      db = "up";
    } catch (error) {
      // Health must still return, not throw — but a probe that hides why the database is down
      // leaves the operator guessing (docs/conventions.md §6: never swallow errors).
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`database health probe failed: ${reason}`);
    }
    return { status: "ok", db };
  }
}
