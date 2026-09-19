import { Logger } from "@nestjs/common";
import type { DataSource } from "typeorm";

import { HealthController } from "./health.controller";

/**
 * HealthController's own doc comment makes two claims this suite tries to break:
 *   1. "db reflects a real SELECT 1" and status stays "ok" even when the DB is down (a 503 here
 *      would make a load balancer treat a live process as unhealthy and restart it, per the
 *      comment) — so a failing probe must still resolve, not throw, and must report db: "down".
 *   2. The probe "must still return, not throw — but ... leaves the operator guessing" if it hides
 *      the reason, so a failure must be logged via Nest's Logger with the underlying error message,
 *      and a success must log nothing at all (an operator paging on every successful health check
 *      would drown the real signal).
 */
describe("HealthController", () => {
  function stubDataSource(query: () => Promise<unknown>): DataSource {
    return { query } as unknown as DataSource;
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns { status: 'ok', db: 'up' } when SELECT 1 succeeds, and logs nothing", async () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const dataSource = stubDataSource(() => Promise.resolve([{ "?column?": 1 }]));
    const controller = new HealthController(dataSource);

    const result = await controller.check();

    expect(result).toEqual({ status: "ok", db: "up" });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns { status: 'ok', db: 'down' } when SELECT 1 rejects — the probe never throws to the caller", async () => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const dataSource = stubDataSource(() => Promise.reject(new Error("connection terminated")));
    const controller = new HealthController(dataSource);

    // If the implementation regresses to letting the query rejection propagate, this await itself
    // throws and the test fails here — the assertion below is only reached on the correct behavior.
    const result = await controller.check();

    expect(result).toEqual({ status: "ok", db: "down" });
  });

  it("logs a warning containing the underlying error message on a failing probe, instead of swallowing it", async () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const dataSource = stubDataSource(() =>
      Promise.reject(new Error("terminating connection due to administrator command")),
    );
    const controller = new HealthController(dataSource);

    await controller.check();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining("terminating connection due to administrator command"),
    );
  });

  it("still returns db: 'down' and logs a message when the rejection is not an Error instance", async () => {
    // `error instanceof Error ? error.message : String(error)` is the exact line this guards: a
    // driver or mock that rejects with a plain string/object (not an Error) must not crash the
    // reason-extraction logic or produce a log line with no useful content (e.g. "[object Object]"
    // silently swallowed would fail the "must not hide why" claim just as much as no log at all).
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    // Deliberately a non-Error rejection: this is exactly the shape health.controller.ts's
    // `error instanceof Error ? ... : String(error)` branch exists to handle.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const dataSource = stubDataSource(() => Promise.reject("connection refused"));
    const controller = new HealthController(dataSource);

    const result = await controller.check();

    expect(result).toEqual({ status: "ok", db: "down" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toEqual(expect.stringContaining("connection refused"));
  });

  it("calling check() twice logs a warning both times when the probe keeps failing (no swallow-after-first)", async () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const dataSource = stubDataSource(() => Promise.reject(new Error("still down")));
    const controller = new HealthController(dataSource);

    await controller.check();
    await controller.check();

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
