/**
 * OpenTelemetry bootstrap.
 *
 * MUST be imported before any other module (especially before NestFactory) so that
 * auto-instrumentations can patch http/express/pg/undici. Wire this up as the very first
 * import in `main.ts`:  `import "./observability/otel";`
 *
 * TODO(Phase 4): initialize NodeSDK with:
 *   - resource attrs: service.name=chainstake-indexer, service.version=<git sha>, deployment.environment
 *   - auto-instrumentations-node (http, express/nest, pg, undici)
 *   - OTLPTraceExporter (gRPC) -> OTel Collector (OTEL_EXPORTER_OTLP_ENDPOINT) -> Jaeger
 *   - sdk.start(); graceful shutdown on SIGTERM.
 */

export {};
