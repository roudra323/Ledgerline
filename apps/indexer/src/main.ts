// OTel must be first — before Nest/express are imported (Phase 4 fills otel.ts).
import "./observability/otel";

import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module";
import type { Env } from "./config/env.schema";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Enable graceful shutdown
  app.enableShutdownHooks();

  // TODO(Phase 4): app.useLogger(app.get(Logger)) for nestjs-pino with trace_id injection.
  // TODO(Phase 3): global metrics interceptor (RED method) is registered via ObservabilityModule.

  const configService = app.get(ConfigService<Env, true>);
  const port = configService.get("INDEXER_PORT", { infer: true });
  await app.listen(port);
}

// A rejection here means a failed boot, not a recoverable error — exit non-zero so
// orchestrators restart us cleanly instead of half-booting. (No logger exists yet;
// console.error is the only honest sink at this point.)
bootstrap().catch((err) => {
  console.error("Failed to start application:", err);
  process.exit(1);
});
