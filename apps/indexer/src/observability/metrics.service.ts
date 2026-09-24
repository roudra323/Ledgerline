import { Injectable } from "@nestjs/common";
import { InjectMetric } from "@willsoto/nestjs-prometheus";
import { Counter } from "prom-client";

import type { LedgerRejectionReason } from "../ledger/ledger-errors";

/** Instrument names, from docs/observability.md §1 — the owner of this table. */
export const LEDGER_ENTRIES_WRITTEN = "ledgerline_ledger_entries_written_total";
export const LEDGER_POSTINGS_REJECTED = "ledgerline_ledger_postings_rejected_total";

/**
 * MetricsService — the one place that owns every `ledgerline_*` Prometheus instrument.
 *
 * Names, types and labels are specified in docs/observability.md §1, which owns them; this class
 * is an implementation of that table. **The permitted label set there is exhaustive.** Never a
 * merchant id, customer id, address, tx hash or payment id — unbounded label cardinality is how you
 * take a Prometheus down. Those identifiers belong in span attributes and structured logs, where
 * cardinality is free and where you actually need them during an incident.
 *
 * Instruments are added as the paths that emit them are built, not in one batch at the end:
 * CLAUDE.md's definition of done requires a metric on every new path, and a checklist item you
 * cannot satisfy is one that gets skipped.
 *
 * TODO(Part 7): the remaining ~45 instruments in docs/observability.md §1, plus the RED-method HTTP
 * interceptor covering every route automatically.
 */
@Injectable()
export class MetricsService {
  constructor(
    @InjectMetric(LEDGER_ENTRIES_WRITTEN)
    private readonly ledgerEntriesWritten: Counter<"kind">,
    @InjectMetric(LEDGER_POSTINGS_REJECTED)
    private readonly ledgerPostingsRejected: Counter<"kind" | "reason_class">,
  ) {}

  /**
   * Counts entry rows actually inserted, labelled by the transaction kind that caused them.
   *
   * Called only when a posting really wrote — a redelivered cause that resolves to
   * `alreadyPosted` inserts nothing, and counting it would overstate ledger activity and mask a
   * genuine drop in throughput behind retry noise.
   */
  recordLedgerEntriesWritten(kind: string, entryCount: number): void {
    this.ledgerEntriesWritten.inc({ kind }, entryCount);
  }

  /**
   * Counts postings the ledger refused, by kind and reason (`unbalanced`, `negative_balance`,
   * `idempotency_conflict`). `negative_balance` on a treasury kind is the float running dry; the
   * other two have no benign cause.
   *
   * Only rejections `LedgerService.post()` itself observes: a posting joined to a caller's
   * transaction is rejected at the caller's COMMIT, which the caller must count.
   */
  recordLedgerPostingRejected(kind: string, reasonClass: LedgerRejectionReason): void {
    this.ledgerPostingsRejected.inc({ kind, reason_class: reasonClass });
  }
}
