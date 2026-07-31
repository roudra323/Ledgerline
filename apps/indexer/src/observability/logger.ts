/**
 * Structured logging config (nestjs-pino).
 *
 * TODO(Phase 4): export pino-http options with:
 *   - JSON output, level from LOG_LEVEL.
 *   - a mixin that injects trace_id / span_id from the active OTel span into every log line,
 *     closing the logs <-> traces correlation loop.
 *   - redaction of any sensitive fields.
 */

export {};
