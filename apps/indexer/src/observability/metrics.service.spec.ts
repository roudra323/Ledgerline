import { Counter, Registry } from "prom-client";

import {
  LEDGER_ENTRIES_WRITTEN,
  LEDGER_POSTINGS_REJECTED,
  MetricsService,
} from "./metrics.service";

/**
 * Unit tests for MetricsService — using a REAL prom-client Counter on a throwaway Registry, not a
 * stub. A stubbed `.inc()` call cannot fail: it can't catch a wrong label name, a wrong value, or
 * an accidental extra label sneaking onto the metric. Only a real Counter's `.get()` output can.
 */
function buildMetrics(): {
  service: MetricsService;
  counter: Counter<"kind">;
  rejectedCounter: Counter<"kind" | "reason_class">;
} {
  const counter = new Counter({
    name: LEDGER_ENTRIES_WRITTEN,
    help: "test",
    labelNames: ["kind"],
    registers: [new Registry()],
  });
  const rejectedCounter = new Counter({
    name: LEDGER_POSTINGS_REJECTED,
    help: "test",
    labelNames: ["kind", "reason_class"],
    registers: [new Registry()],
  });
  return {
    service: new MetricsService(counter, rejectedCounter),
    counter,
    rejectedCounter,
  };
}

describe("MetricsService.recordLedgerEntriesWritten", () => {
  it("increments the counter by exactly the entry count, labelled by kind", async () => {
    const { service, counter } = buildMetrics();

    service.recordLedgerEntriesWritten("onramp.capture", 4);

    const metric = await counter.get();
    const captureSeries = metric.values.find((value) => value.labels.kind === "onramp.capture");
    expect(captureSeries?.value).toBe(4);
  });

  it("accumulates across repeated calls for the same kind rather than overwriting", async () => {
    const { service, counter } = buildMetrics();

    service.recordLedgerEntriesWritten("onramp.settled", 2);
    service.recordLedgerEntriesWritten("onramp.settled", 3);

    const metric = await counter.get();
    const series = metric.values.find((value) => value.labels.kind === "onramp.settled");
    expect(series?.value).toBe(5);
  });

  it("keeps different kinds as independent label series, not one shared total", async () => {
    const { service, counter } = buildMetrics();

    service.recordLedgerEntriesWritten("onramp.capture", 2);
    service.recordLedgerEntriesWritten("payout.settled", 7);

    const metric = await counter.get();
    const capture = metric.values.find((value) => value.labels.kind === "onramp.capture");
    const payout = metric.values.find((value) => value.labels.kind === "payout.settled");
    expect(capture?.value).toBe(2);
    expect(payout?.value).toBe(7);
  });

  /**
   * docs/observability.md §1's permitted label set is exhaustive: no merchant id, cause id, or
   * other high-cardinality value may ever be attached. This asserts the *shape* of what actually
   * got recorded on the real series — the only place a smuggled-in label would be observable —
   * rather than trusting the method signature not to grow one later.
   */
  it("attaches only the permitted 'kind' label — no high-cardinality label is ever recorded", async () => {
    const { service, counter } = buildMetrics();

    service.recordLedgerEntriesWritten("onramp.capture", 1);

    const metric = await counter.get();
    const series = metric.values.find((value) => value.labels.kind === "onramp.capture");
    expect(series).toBeDefined();
    expect(Object.keys(series?.labels ?? {})).toEqual(["kind"]);
  });

  it("a zero-entry posting records a zero-valued series rather than being silently skipped", async () => {
    const { service, counter } = buildMetrics();

    service.recordLedgerEntriesWritten("fx.residual", 0);

    const metric = await counter.get();
    const series = metric.values.find((value) => value.labels.kind === "fx.residual");
    // inc({kind}, 0) still creates the label series at 0 — this pins that prom-client behaviour so
    // a future refactor that special-cases "0 entries" (e.g. `if (entryCount) counter.inc(...)`)
    // gets caught by this test rather than silently starting to skip the series.
    expect(series?.value).toBe(0);
  });
});

describe("MetricsService.recordLedgerPostingRejected", () => {
  function seriesFor(
    metric: Awaited<ReturnType<Counter<"kind" | "reason_class">["get"]>>,
    kind: string,
    reasonClass: string,
  ) {
    return metric.values.find(
      (value) => value.labels.kind === kind && value.labels.reason_class === reasonClass,
    );
  }

  it("increments the counter by exactly 1 per call, labelled by kind and reason_class", async () => {
    const { service, rejectedCounter } = buildMetrics();

    service.recordLedgerPostingRejected("onramp.capture", "unbalanced");

    const metric = await rejectedCounter.get();
    const series = seriesFor(metric, "onramp.capture", "unbalanced");
    expect(series?.value).toBe(1);
  });

  it("accumulates across repeated calls for the same (kind, reason_class) rather than overwriting", async () => {
    const { service, rejectedCounter } = buildMetrics();

    service.recordLedgerPostingRejected("payout.burned", "negative_balance");
    service.recordLedgerPostingRejected("payout.burned", "negative_balance");
    service.recordLedgerPostingRejected("payout.burned", "negative_balance");

    const metric = await rejectedCounter.get();
    const series = seriesFor(metric, "payout.burned", "negative_balance");
    expect(series?.value).toBe(3);
  });

  it("keeps different kinds as independent series for the SAME reason_class, not one shared total", async () => {
    const { service, rejectedCounter } = buildMetrics();

    service.recordLedgerPostingRejected("onramp.capture", "unbalanced");
    service.recordLedgerPostingRejected("onramp.capture", "unbalanced");
    service.recordLedgerPostingRejected("payout.requested", "unbalanced");

    const metric = await rejectedCounter.get();
    expect(seriesFor(metric, "onramp.capture", "unbalanced")?.value).toBe(2);
    expect(seriesFor(metric, "payout.requested", "unbalanced")?.value).toBe(1);
  });

  it("keeps different reason_classes as independent series for the SAME kind, not one shared total", async () => {
    const { service, rejectedCounter } = buildMetrics();

    service.recordLedgerPostingRejected("payout.burned", "unbalanced");
    service.recordLedgerPostingRejected("payout.burned", "negative_balance");
    service.recordLedgerPostingRejected("payout.burned", "negative_balance");
    service.recordLedgerPostingRejected("payout.burned", "idempotency_conflict");

    const metric = await rejectedCounter.get();
    expect(seriesFor(metric, "payout.burned", "unbalanced")?.value).toBe(1);
    expect(seriesFor(metric, "payout.burned", "negative_balance")?.value).toBe(2);
    expect(seriesFor(metric, "payout.burned", "idempotency_conflict")?.value).toBe(1);
  });

  /**
   * docs/observability.md §1's permitted label set is exhaustive, and ADR-0019 fixes reason_class
   * to exactly three values. This asserts the *shape* actually recorded on the real series — the
   * only place a smuggled-in label (e.g. a raw error message) would be observable — rather than
   * trusting the method signature not to grow one later.
   */
  it("attaches only the permitted 'kind' and 'reason_class' labels — no high-cardinality label is ever recorded", async () => {
    const { service, rejectedCounter } = buildMetrics();

    service.recordLedgerPostingRejected("onramp.settled", "idempotency_conflict");

    const metric = await rejectedCounter.get();
    const series = seriesFor(metric, "onramp.settled", "idempotency_conflict");
    expect(series).toBeDefined();
    expect(Object.keys(series?.labels ?? {}).sort()).toEqual(["kind", "reason_class"]);
  });

  it("does not touch the entries-written counter — the two instruments are independent", async () => {
    const { service, counter, rejectedCounter } = buildMetrics();

    service.recordLedgerPostingRejected("onramp.capture", "unbalanced");

    const entriesMetric = await counter.get();
    expect(entriesMetric.values).toHaveLength(0);
    const rejectedMetric = await rejectedCounter.get();
    expect(rejectedMetric.values).toHaveLength(1);
  });
});
