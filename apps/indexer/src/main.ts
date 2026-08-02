// OTel must be first — before Nest/express are imported (Phase 4 fills otel.ts).
import "./observability/otel";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // TODO(Phase 4): app.useLogger(app.get(Logger)) for nestjs-pino with trace_id injection.
  // TODO(Phase 3): global metrics interceptor (RED method) is registered via ObservabilityModule.

  const port = Number(process.env.INDEXER_PORT ?? 3001);
  await app.listen(port);
}

void bootstrap();
