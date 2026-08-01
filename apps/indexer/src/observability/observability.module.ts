import { Module } from "@nestjs/common";

/**
 * ObservabilityModule — metrics + logging wiring.
 *
 * TODO(Phase 3):
 *   - PrometheusModule.register() from @willsoto/nestjs-prometheus (exposes GET /metrics).
 *   - MetricsService providing the ledgerline_* instruments (see metrics.service.ts).
 *   - a global HTTP interceptor implementing the RED method (http_requests_total,
 *     http_request_duration_seconds, in-flight gauge) so every route is covered automatically.
 * TODO(Phase 4): LoggerModule.forRoot (nestjs-pino) with trace_id/span_id injection.
 */
@Module({
  imports: [],
  providers: [],
  exports: [],
})
export class ObservabilityModule {}
