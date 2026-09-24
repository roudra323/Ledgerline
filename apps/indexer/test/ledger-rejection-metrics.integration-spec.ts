import { randomUUID } from "node:crypto";

import "reflect-metadata";
import { Counter, Registry } from "prom-client";
import { DataSource } from "typeorm";

import { appDataSourceOptions } from "../src/data-source";
import { AccountRegistryService } from "../src/ledger/account-registry.service";
import { LedgerAccount } from "../src/ledger/entities/ledger-account.entity";
import {
  LedgerNegativeBalanceError,
  LedgerUnbalancedError,
  toLedgerError,
} from "../src/ledger/ledger-errors";
import { LedgerService } from "../src/ledger/ledger.service";
import type { PostingRequest } from "../src/ledger/ledger.types";
import { MetricsService } from "../src/observability/metrics.service";

/**
 * `ledgerline_ledger_postings_rejected_total{kind, reason_class}` per ADR-0019: every typed
 * rejection `post()` itself observes increments it, and — the sharper half of the claim — a
 * rejection that happens at a JOINED caller's own COMMIT does NOT, because post() is no longer on
 * the stack when the deferred trigger fires there.
 */
describe("ledgerline_ledger_postings_rejected_total — real post() against a real database", () => {
  let dataSource: DataSource;
  let ledger: LedgerService;
  let rejectedCounter: Counter<"kind" | "reason_class">;

  beforeAll(async () => {
    dataSource = new DataSource(appDataSourceOptions);
    await dataSource.initialize();
    const accounts = new AccountRegistryService(dataSource.getRepository(LedgerAccount));
    rejectedCounter = new Counter({
      name: "ledgerline_ledger_postings_rejected_total",
      help: "test",
      labelNames: ["kind", "reason_class"],
      registers: [new Registry()],
    });
    const metrics = new MetricsService(
      new Counter({
        name: "ledgerline_ledger_entries_written_total",
        help: "test",
        labelNames: ["kind"],
        registers: [new Registry()],
      }),
      rejectedCounter,
    );
    ledger = new LedgerService(dataSource, accounts, metrics);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function rejectedCount(kind: string, reasonClass: string): Promise<number> {
    const metric = await rejectedCounter.get();
    const series = metric.values.find(
      (value) => value.labels.kind === kind && value.labels.reason_class === reasonClass,
    );
    return series?.value ?? 0;
  }

  /** The platform 1100 token_treasury balance, debit-positive (its normal side). Read live because
   * this is a shared platform account other spec files also fund/spend. */
  async function treasuryBalanceUsdx(): Promise<bigint> {
    const rows = await dataSource.query<{ balance: string }[]>(
      `SELECT COALESCE(SUM(CASE WHEN e.direction = 'debit' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS balance
         FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.code = '1100' AND a.asset_code = 'USDX' AND a.owner_type = 'platform'`,
    );
    return BigInt(rows[0]?.balance ?? "0");
  }

  it("a TypeScript pre-check unbalanced posting counts under reason_class=unbalanced", async () => {
    const kind = "compliance.frozen";
    const request: PostingRequest = {
      kind,
      cause: { type: "test", id: `metrics-unbalanced-${randomUUID()}` },
      entries: [
        { accountCode: "1000", direction: "debit", assetCode: "USD", amountMinor: "500" },
        { accountCode: "2100", direction: "credit", assetCode: "USD", amountMinor: "1" },
      ],
    };

    await expect(ledger.post(request)).rejects.toBeInstanceOf(LedgerUnbalancedError);
    expect(await rejectedCount(kind, "unbalanced")).toBe(1);
  });

  it("a database-rejected floor breach on post()'s OWN transaction counts under reason_class=negative_balance", async () => {
    const kind = "reconciliation.adjustment";
    const overdraw = ((await treasuryBalanceUsdx()) + 1n).toString();
    const request: PostingRequest = {
      kind,
      cause: { type: "test", id: `metrics-negative-own-tx-${randomUUID()}` },
      entries: [
        { accountCode: "1810", direction: "debit", assetCode: "USDX", amountMinor: overdraw },
        { accountCode: "1100", direction: "credit", assetCode: "USDX", amountMinor: overdraw },
      ],
    };

    await expect(ledger.post(request)).rejects.toBeInstanceOf(LedgerNegativeBalanceError);
    expect(await rejectedCount(kind, "negative_balance")).toBe(1);
  });

  it("a floor breach at a JOINED caller's COMMIT is NOT counted by post() — the caller owns that count", async () => {
    const kind = "chargeback.received";
    const causeId = `metrics-negative-joined-${randomUUID()}`;
    const overdraw = ((await treasuryBalanceUsdx()) + 1n).toString();

    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    // post() itself must not throw here: the deferred trigger has not run yet.
    await ledger.post(
      {
        kind,
        cause: { type: "test", id: causeId },
        entries: [
          { accountCode: "1810", direction: "debit", assetCode: "USDX", amountMinor: overdraw },
          { accountCode: "1100", direction: "credit", assetCode: "USDX", amountMinor: overdraw },
        ],
      },
      queryRunner,
    );
    expect(await rejectedCount(kind, "negative_balance")).toBe(0);

    let commitError: unknown;
    try {
      await queryRunner.commitTransaction();
    } catch (error) {
      commitError = error;
    } finally {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      await queryRunner.release();
    }

    // The caller CAN classify it via toLedgerError() — the capability exists...
    expect(commitError).toBeDefined();
    expect(toLedgerError(commitError)).toBeInstanceOf(LedgerNegativeBalanceError);
    // ...but post() itself never saw the failure, so its own counter must still read zero for this
    // kind. If a future change makes post() somehow observe and count this, this must start failing.
    expect(await rejectedCount(kind, "negative_balance")).toBe(0);
  });
});
