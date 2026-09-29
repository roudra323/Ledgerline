import { Module } from "@nestjs/common";
import { PrometheusModule, makeCounterProvider } from "@willsoto/nestjs-prometheus";

import {
  LEDGER_ENTRIES_WRITTEN,
  LEDGER_POSTINGS_REJECTED,
  MetricsService,
} from "./metrics.service";

/**
 * ObservabilityModule — metrics and logging wiring.
 *
 * `PrometheusModule.register()` exposes `GET /metrics`. Registered now, with a single instrument,
 * rather than in Part 7 with all of them: until this module was wired, "every new path gets a
 * metric" was unenforceable rather than merely unenforced, so the definition of done was quietly
 * unsatisfiable for every block.
 *
 * TODO(Part 7): the rest of docs/observability.md §1's instruments, and a global HTTP interceptor
 *   implementing the RED method so every route is covered without being remembered.
 * TODO(Part 7): LoggerModule.forRoot (nestjs-pino) with trace_id/span_id injection, closing the
 *   logs <-> traces correlation loop.
 */
@Module({
  imports: [PrometheusModule.register()],
  providers: [
    makeCounterProvider({
      name: LEDGER_ENTRIES_WRITTEN,
      help: "Ledger entry rows written, by the transaction kind that caused them",
      labelNames: ["kind"],
    }),
    makeCounterProvider({
      name: LEDGER_POSTINGS_REJECTED,
      help: "Ledger postings refused, by transaction kind and reason class",
      labelNames: ["kind", "reason_class"],
    }),
    MetricsService,
  ],
  exports: [MetricsService],
})
export class ObservabilityModule {}
