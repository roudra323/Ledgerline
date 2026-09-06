import { Counter, Registry } from "prom-client";

import { LEDGER_ENTRIES_WRITTEN, MetricsService } from "./metrics.service";

/**
 * Unit tests for MetricsService — using a REAL prom-client Counter on a throwaway Registry, not a
 * stub. A stubbed `.inc()` call cannot fail: it can't catch a wrong label name, a wrong value, or
 * an accidental extra label sneaking onto the metric. Only a real Counter's `.get()` output can.
 */
describe("MetricsService.recordLedgerEntriesWritten", () => {
  function buildMetrics(): { service: MetricsService; counter: Counter<"kind"> } {
    const counter = new Counter({
      name: LEDGER_ENTRIES_WRITTEN,
      help: "test",
      labelNames: ["kind"],
      registers: [new Registry()],
    });
    return { service: new MetricsService(counter), counter };
  }

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
