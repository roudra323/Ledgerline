import { randomUUID } from "node:crypto";

import "reflect-metadata";
import { Counter, Registry } from "prom-client";
import { DataSource } from "typeorm";

import { appDataSourceOptions } from "../src/data-source";
import { AccountRegistryService } from "../src/ledger/account-registry.service";
import { LedgerAccount } from "../src/ledger/entities/ledger-account.entity";
import { LedgerService } from "../src/ledger/ledger.service";
import type { PostingRequest } from "../src/ledger/ledger.types";
import { MetricsService } from "../src/observability/metrics.service";

/**
 * `post(request, joinTransaction)` claims that when a caller supplies its own `QueryRunner`, the
 * posting neither commits nor rolls back on its own — the caller's COMMIT is where the deferred
 * balance trigger fires. That is a false-atomicity claim of exactly the kind that looks correct in
 * source and is not, so it gets a test that rolls the OUTER transaction back and asserts nothing
 * survives.
 *
 * It also covers the subtler half: resolving a leg can CREATE a per-merchant account, and that
 * creation used to run on `AccountRegistryService`'s own connection, so it committed independently
 * and outlived a rolled-back posting.
 */
describe("LedgerService.post() joining a caller's transaction", () => {
  let dataSource: DataSource;
  let ledger: LedgerService;

  beforeAll(async () => {
    dataSource = new DataSource(appDataSourceOptions);
    await dataSource.initialize();
    ledger = new LedgerService(
      dataSource,
      new AccountRegistryService(dataSource.getRepository(LedgerAccount)),
      new MetricsService(
        new Counter({
          name: "ledgerline_ledger_entries_written_total",
          help: "test",
          labelNames: ["kind"],
          registers: [new Registry()],
        }),
      ),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  function onrampToMerchant(merchantId: string, causeId: string): PostingRequest {
    return {
      kind: "onramp.settled",
      cause: { type: "fiat_event", id: causeId },
      entries: [
        { accountCode: "1100", direction: "debit", assetCode: "USDX", amountMinor: "5000000" },
        {
          accountCode: "2000",
          direction: "credit",
          assetCode: "USDX",
          amountMinor: "5000000",
          merchantId,
        },
      ],
    };
  }

  /** The platform 1100 token_treasury balance, debit-positive (its normal side). */
  async function treasuryBalanceUsdx(): Promise<bigint> {
    const rows = await dataSource.query<{ balance: string }[]>(
      `SELECT COALESCE(SUM(CASE WHEN e.direction = 'debit' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS balance
         FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.code = '1100' AND a.asset_code = 'USDX' AND a.owner_type = 'platform'`,
    );
    return BigInt(rows[0]?.balance ?? "0");
  }

  async function countTransactions(causeId: string): Promise<number> {
    const rows = await dataSource.query<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM ledger_transactions WHERE cause_id = $1`,
      [causeId],
    );
    return Number(rows[0]?.count ?? "0");
  }

  async function countMerchantAccounts(merchantId: string): Promise<number> {
    const rows = await dataSource.query<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM ledger_accounts WHERE owner_id = $1`,
      [merchantId],
    );
    return Number(rows[0]?.count ?? "0");
  }

  it("commits with the caller's transaction, not before it", async () => {
    const merchantId = randomUUID();
    const causeId = `evt_${randomUUID()}`;

    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    await ledger.post(onrampToMerchant(merchantId, causeId), queryRunner);

    // Still inside the caller's transaction: another connection must not see any of it yet.
    expect(await countTransactions(causeId)).toBe(0);

    await queryRunner.commitTransaction();
    await queryRunner.release();

    expect(await countTransactions(causeId)).toBe(1);
    expect(await countMerchantAccounts(merchantId)).toBe(1);
  });

  it("leaves nothing behind when the caller rolls back — including a merchant account it created", async () => {
    const merchantId = randomUUID();
    const causeId = `evt_${randomUUID()}`;

    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    await ledger.post(onrampToMerchant(merchantId, causeId), queryRunner);
    await queryRunner.rollbackTransaction();
    await queryRunner.release();

    expect(await countTransactions(causeId)).toBe(0);
    // The regression this test exists for: account creation used to run on the registry's own
    // connection and commit independently, so it survived the rollback of the posting that caused it.
    expect(await countMerchantAccounts(merchantId)).toBe(0);
  });

  it("surfaces a trigger rejection at the caller's COMMIT, not inside post()", async () => {
    const causeId = `evt_${randomUUID()}`;
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    // Balanced in TypeScript and rejected by the database: 1100 token_treasury is
    // allows_negative = false, and crediting it by one more than it holds drives it below zero.
    // The amount is read live, never fixed: 1100 is a shared platform account that other spec
    // files legitimately fund (ledger-flows mints float), so a hard-coded "large enough" credit is
    // only large enough until one of them runs first.
    const overdraw = ((await treasuryBalanceUsdx()) + 1n).toString();
    await ledger.post(
      {
        kind: "payout.burned",
        cause: { type: "fiat_event", id: causeId },
        entries: [
          { accountCode: "1810", direction: "debit", assetCode: "USDX", amountMinor: overdraw },
          { accountCode: "1100", direction: "credit", assetCode: "USDX", amountMinor: overdraw },
        ],
      },
      queryRunner,
    );

    // post() returned without throwing — the deferred trigger has not run yet. It runs here.
    await expect(queryRunner.commitTransaction()).rejects.toThrow(/allows_negative = false/i);
    await queryRunner.release();

    expect(await countTransactions(causeId)).toBe(0);
  });
});
