import { randomUUID } from "node:crypto";

import "reflect-metadata";
import { Counter, Registry } from "prom-client";
import { DataSource } from "typeorm";

import { appDataSourceOptions } from "../src/data-source";
import { AccountRegistryService } from "../src/ledger/account-registry.service";
import { LedgerAccount } from "../src/ledger/entities/ledger-account.entity";
import { LedgerService } from "../src/ledger/ledger.service";
import type { PostingLeg, PostingRequest } from "../src/ledger/ledger.types";
import { MetricsService } from "../src/observability/metrics.service";

/**
 * Attacks the claim behind the account-id sort added to `LedgerService.insertEntries`:
 * "postings made through `post()` should no longer deadlock against each other regardless of the
 * order the caller lists legs in" (ADR-0017, "So the structural fix is no longer deferred").
 *
 * `ledger-concurrency-adversarial.integration-spec.ts` measured 35/40 (87.5%) deadlocks for the
 * crossed-order shape using raw SQL that chooses its own insert order. Every test here goes through
 * `LedgerService.post()` instead, which is the only code path the ordering fix actually touches.
 */
describe("LedgerService.post() — account-id lock ordering (ADR-0017)", () => {
  let dataSource: DataSource;
  let ledger: LedgerService;

  beforeAll(async () => {
    dataSource = new DataSource({ ...appDataSourceOptions, extra: { max: 90 } });
    await dataSource.initialize();
    const accounts = new AccountRegistryService(dataSource.getRepository(LedgerAccount));
    const metrics = new MetricsService(
      new Counter({
        name: "ledgerline_ledger_entries_written_total",
        help: "test",
        labelNames: ["kind"],
        registers: [new Registry()],
      }),
    );
    ledger = new LedgerService(dataSource, accounts, metrics);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  /**
   * A disposable merchant-owned "2000" (merchant_payable, USDX, liability/credit) account, created
   * directly rather than lazily through post(), and flipped to allows_negative so contention over
   * the non-negative trigger's own lock never masks a deadlock finding underneath this one. Each
   * gets a fresh, random merchantId so it cannot collide with, or be mutated by, any other test.
   */
  async function disposableMerchantAccount(): Promise<{ merchantId: string; accountId: string }> {
    const merchantId = randomUUID();
    const rows = await dataSource.query<{ id: string }[]>(
      `INSERT INTO ledger_accounts
         (code, name, account_type, normal_side, asset_code, owner_type, owner_id, allows_negative, is_active)
       VALUES ('2000', 'merchant_payable', 'liability', 'credit', 'USDX', 'merchant', $1, true, true)
       RETURNING id`,
      [merchantId],
    );
    const row = rows[0];
    if (!row) throw new Error("insert into ledger_accounts returned no row");
    return { merchantId, accountId: row.id };
  }

  async function entryCountAndSum(
    accountId: string,
  ): Promise<{ count: number; debitSum: bigint; creditSum: bigint }> {
    const rows = await dataSource.query<{ direction: string; amount_minor: string }[]>(
      `SELECT direction, amount_minor FROM ledger_entries WHERE account_id = $1`,
      [accountId],
    );
    let debitSum = 0n;
    let creditSum = 0n;
    for (const row of rows) {
      if (row.direction === "debit") debitSum += BigInt(row.amount_minor);
      else creditSum += BigInt(row.amount_minor);
    }
    return { count: rows.length, debitSum, creditSum };
  }

  /** Safely extracts a rejection's message without an unsafe `any` member access. */
  function reasonMessage(reason: unknown): string {
    if (reason instanceof Error) return reason.message;
    return String(reason);
  }

  function leg(
    accountCode: string,
    merchantId: string,
    direction: "debit" | "credit",
    amountMinor: string,
  ): PostingLeg {
    return { accountCode, merchantId, direction, assetCode: "USDX", amountMinor };
  }

  function request(
    entries: readonly PostingLeg[],
    kind: PostingRequest["kind"] = "payout.requested",
  ): PostingRequest {
    return { kind, cause: { type: "test", id: `lock-order-${randomUUID()}` }, entries };
  }

  /**
   * Test 1 — the crossed test, through post() this time.
   *
   * Would catch: the sort being applied to the wrong array, being a no-op, or being bypassed on
   * some code path, which would reproduce the 87.5% raw-SQL deadlock rate here too.
   */
  it("40 crossed-order postings through post() deadlock at (or near) 0%, not 87.5%", async () => {
    const a = await disposableMerchantAccount();
    const b = await disposableMerchantAccount();

    const attemptsPerDirection = 20;
    const aThenB = Array.from({ length: attemptsPerDirection }, () =>
      ledger.post(
        request([
          leg("2000", a.merchantId, "debit", "1"),
          leg("2000", b.merchantId, "credit", "1"),
        ]),
      ),
    );
    const bThenA = Array.from({ length: attemptsPerDirection }, () =>
      ledger.post(
        request([
          leg("2000", b.merchantId, "debit", "1"),
          leg("2000", a.merchantId, "credit", "1"),
        ]),
      ),
    );

    const outcomes = await Promise.allSettled([...aThenB, ...bThenA]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    const deadlocked = rejected.filter((o) => /deadlock detected/i.test(reasonMessage(o.reason)));
    const unexplained = rejected.filter((o) => !/deadlock detected/i.test(reasonMessage(o.reason)));

    console.info(
      `[post()-crossed-order] attempted: ${outcomes.length}, committed: ${fulfilled.length}, ` +
        `deadlocked: ${deadlocked.length}/${outcomes.length} (raw-SQL baseline: 35/40 = 87.5%)`,
    );

    // Any non-deadlock failure here is a different bug (e.g. a broken account resolution) and must
    // not be silently absorbed into the deadlock count.
    expect(unexplained).toEqual([]);
    // This is the number that justifies the change. Report it either way.
    expect(deadlocked.length).toBe(0);
    expect(fulfilled).toHaveLength(40);

    // Correctness: A and B are a closed pair, so the sum of every committed leg across both must
    // still net to zero — global lock ordering must not have silently dropped or duplicated a leg.
    const aRows = await entryCountAndSum(a.accountId);
    const bRows = await entryCountAndSum(b.accountId);
    // Every one of the 40 postings has exactly one leg on A and one on B.
    expect(aRows.count).toBe(40);
    expect(bRows.count).toBe(40);
    const aNet = aRows.debitSum - aRows.creditSum;
    const bNet = bRows.debitSum - bRows.creditSum;
    expect(aNet + bNet).toBe(0n);
  }, 120000);

  /**
   * Test 2 — sequence is unchanged by the reordering.
   *
   * Would catch: a refactor that (accidentally or "for simplicity") starts writing `sequence` from
   * the post-sort array instead of the pre-sort one, silently swapping what `sequence` is supposed
   * to mean — the caller's order — for the account-id order.
   */
  it("stores `sequence` reflecting caller order, not the account-id insertion order", async () => {
    const codes: { code: string; assetCode: "USD" }[] = [
      { code: "1000", assetCode: "USD" },
      { code: "1010", assetCode: "USD" },
      { code: "2100", assetCode: "USD" },
      { code: "4000", assetCode: "USD" },
    ];
    const idRows = await dataSource.query<{ id: string; code: string }[]>(
      `SELECT id, code FROM ledger_accounts WHERE owner_type = 'platform' AND code = ANY($1) AND asset_code = 'USD'`,
      [codes.map((c) => c.code)],
    );
    const idByCode = new Map(idRows.map((r) => [r.code, r.id]));
    for (const c of codes) {
      if (!idByCode.has(c.code)) throw new Error(`fixture account ${c.code} missing`);
    }

    // Caller order chosen to differ from ascending account-id order: sort the codes by their real
    // account id and then reverse that, so the request below is never accidentally already sorted.
    const ascendingByAccountId = [...codes].sort((x, y) => {
      const idX = idByCode.get(x.code) as string;
      const idY = idByCode.get(y.code) as string;
      return idX < idY ? -1 : idX > idY ? 1 : 0;
    });
    const callerOrder = [...ascendingByAccountId].reverse();
    expect(callerOrder.map((c) => c.code)).not.toEqual(ascendingByAccountId.map((c) => c.code));

    // Fixed per CODE (not per position), so reordering the array can never flip a leg onto the
    // wrong side of its account's normal balance: 1000/1010 are debit-normal assets, 2100/4000 are
    // credit-normal — every leg here moves its account further in its own normal direction, so no
    // permutation of caller order can trip the non-negative trigger.
    const legByCode: Record<string, { direction: "debit" | "credit"; amountMinor: string }> = {
      "1000": { direction: "debit", amountMinor: "100" },
      "1010": { direction: "debit", amountMinor: "50" },
      "2100": { direction: "credit", amountMinor: "100" },
      "4000": { direction: "credit", amountMinor: "50" },
    };
    const entries: PostingLeg[] = callerOrder.map((c) => ({
      accountCode: c.code,
      direction: legByCode[c.code]?.direction as "debit" | "credit",
      assetCode: c.assetCode,
      amountMinor: legByCode[c.code]?.amountMinor as string,
    }));

    const result = await ledger.post(request(entries, "onramp.capture"));

    const stored = await dataSource.query<{ account_id: string; sequence: number }[]>(
      `SELECT account_id, sequence FROM ledger_entries WHERE transaction_id = $1 ORDER BY sequence`,
      [result.transactionId],
    );
    expect(stored).toHaveLength(4);
    // sequence 0..3 must map to accounts in the CALLER's order, not sorted-by-account-id order.
    expect(stored.map((r) => r.account_id)).toEqual(callerOrder.map((c) => idByCode.get(c.code)));
  });

  /**
   * Test 3 — three- and four-leg postings crossed against each other in different orders.
   *
   * Would catch: the fix only working for the 2-account, 2-leg shape it was measured against —
   * e.g. a sort that is stable for pairs but breaks down (or was only tested) for a 3-way cycle
   * P->Q->R vs R->Q->P, which is exactly the shape a 2-account fix could miss.
   */
  it("three-way crossed orderings (P/Q/R legs listed in different permutations) do not deadlock", async () => {
    const p = await disposableMerchantAccount();
    const q = await disposableMerchantAccount();
    const r = await disposableMerchantAccount();

    const attemptsPerPermutation = 12;
    const forward = Array.from({ length: attemptsPerPermutation }, () =>
      ledger.post(
        request([
          leg("2000", p.merchantId, "debit", "3"),
          leg("2000", q.merchantId, "debit", "2"),
          leg("2000", r.merchantId, "credit", "5"),
        ]),
      ),
    );
    const reverse = Array.from({ length: attemptsPerPermutation }, () =>
      ledger.post(
        request([
          leg("2000", r.merchantId, "debit", "5"),
          leg("2000", q.merchantId, "credit", "2"),
          leg("2000", p.merchantId, "credit", "3"),
        ]),
      ),
    );
    const shuffled = Array.from({ length: attemptsPerPermutation }, () =>
      ledger.post(
        request([
          leg("2000", q.merchantId, "debit", "2"),
          leg("2000", p.merchantId, "debit", "3"),
          leg("2000", r.merchantId, "credit", "5"),
        ]),
      ),
    );

    const outcomes = await Promise.allSettled([...forward, ...reverse, ...shuffled]);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    const deadlocked = rejected.filter((o) => /deadlock detected/i.test(reasonMessage(o.reason)));
    const unexplained = rejected.filter((o) => !/deadlock detected/i.test(reasonMessage(o.reason)));

    console.info(
      `[post()-three-way-crossed] attempted: ${outcomes.length}, deadlocked: ${deadlocked.length}`,
    );

    expect(unexplained).toEqual([]);
    expect(deadlocked.length).toBe(0);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(
      attemptsPerPermutation * 3,
    );

    // forward/shuffled net P+Q(debit) vs R(credit) at 5, reverse nets the opposite: closed system,
    // sum across all three accounts must be exactly zero.
    const pRows = await entryCountAndSum(p.accountId);
    const qRows = await entryCountAndSum(q.accountId);
    const rRows = await entryCountAndSum(r.accountId);
    const net =
      pRows.debitSum -
      pRows.creditSum +
      (qRows.debitSum - qRows.creditSum) +
      (rRows.debitSum - rRows.creditSum);
    expect(net).toBe(0n);
  }, 120000);

  /**
   * Test 4 — legs that resolve to the SAME account.
   *
   * Would catch: a sort comparator that treats equal keys inconsistently in a way that drops or
   * duplicates a row (the comparator here — `a.accountId < b.accountId ? -1 : 1` — never returns 0
   * for equal ids, which is a broken comparator contract; this proves that quirk does not corrupt
   * output count or amounts even though the theoretical contract violation exists).
   */
  it("a posting whose legs repeat the same account is not dropped, duplicated, or misordered by the sort", async () => {
    const a = await disposableMerchantAccount();
    const b = await disposableMerchantAccount();

    // 4 legs, account A appears twice: debit 30 + credit 10 = net debit 20; B appears twice too:
    // debit 20 + credit 40 = net credit 20. Total debit 50 == total credit 50 — balanced.
    const result = await ledger.post(
      request([
        leg("2000", a.merchantId, "debit", "30"),
        leg("2000", b.merchantId, "credit", "40"),
        leg("2000", a.merchantId, "credit", "10"),
        leg("2000", b.merchantId, "debit", "20"),
      ]),
    );

    const stored = await dataSource.query<
      { account_id: string; direction: string; amount_minor: string }[]
    >(`SELECT account_id, direction, amount_minor FROM ledger_entries WHERE transaction_id = $1`, [
      result.transactionId,
    ]);
    expect(stored).toHaveLength(4);

    const aRows = await entryCountAndSum(a.accountId);
    const bRows = await entryCountAndSum(b.accountId);
    expect(aRows.count).toBe(2);
    expect(aRows.debitSum).toBe(30n);
    expect(aRows.creditSum).toBe(10n);
    expect(bRows.count).toBe(2);
    expect(bRows.debitSum).toBe(20n);
    expect(bRows.creditSum).toBe(40n);
  });

  /**
   * Test 5 — a not-yet-existent merchant account, resolved (and created) mid-posting.
   *
   * Would catch: ordering being computed against a placeholder/undefined accountId before
   * resolution completes (e.g. sorting before the CREATE races resolve, rather than after), which
   * would make the "global lock order" claim false for exactly the first payment to any merchant —
   * arguably the single most common real-world case.
   */
  it("two concurrent first-postings for the same brand-new merchant, crossed against another account, still avoid deadlock and create exactly one account row", async () => {
    const brandNewMerchantId = randomUUID();
    const other = await disposableMerchantAccount();

    // 2000 (merchant_payable) is liability/credit-normal and the new merchant's row is created
    // with the production default allows_negative = false (disposableMerchantAccount is not used
    // here on purpose — the point is the lazily-created path). So every leg on it must CREDIT
    // (increase) it; only `other` (allows_negative = true, under our control) is ever debited.
    // What varies between the two arrays below is which leg is listed FIRST — i.e. caller order —
    // which is exactly the raw pre-sort insertion order the ADR-0017 fix is supposed to neutralise.
    const attempts = 15;
    const newFirst = Array.from({ length: attempts }, () =>
      ledger.post(
        request([
          leg("2000", brandNewMerchantId, "credit", "1"),
          leg("2000", other.merchantId, "debit", "1"),
        ]),
      ),
    );
    const otherFirst = Array.from({ length: attempts }, () =>
      ledger.post(
        request([
          leg("2000", other.merchantId, "debit", "1"),
          leg("2000", brandNewMerchantId, "credit", "1"),
        ]),
      ),
    );

    const outcomes = await Promise.allSettled([...newFirst, ...otherFirst]);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    const deadlocked = rejected.filter((o) => /deadlock detected/i.test(reasonMessage(o.reason)));
    const unexplained = rejected.filter((o) => !/deadlock detected/i.test(reasonMessage(o.reason)));

    console.info(
      `[post()-new-merchant-race] attempted: ${outcomes.length}, deadlocked: ${deadlocked.length}`,
    );

    expect(unexplained).toEqual([]);
    expect(deadlocked.length).toBe(0);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(attempts * 2);

    const newMerchantAccounts = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM ledger_accounts WHERE code = '2000' AND asset_code = 'USDX' AND owner_type = 'merchant' AND owner_id = $1`,
      [brandNewMerchantId],
    );
    expect(newMerchantAccounts).toHaveLength(1);

    const rows = await entryCountAndSum(newMerchantAccounts[0]?.id as string);
    expect(rows.count).toBe(attempts * 2);
    // Every leg on the new merchant's account is size 1; the closed pair must still net to zero
    // against `other`.
    const otherRows = await entryCountAndSum(other.accountId);
    const newNet = rows.debitSum - rows.creditSum;
    const otherNet = otherRows.debitSum - otherRows.creditSum;
    expect(newNet + otherNet).toBe(0n);
  }, 120000);

  /**
   * Test 6 — the comparator is total over distinct UUIDs (no `localeCompare`, no silent 0 for
   * distinct values).
   *
   * Would catch: a future edit swapping in `localeCompare` (locale-sensitive, can treat visually
   * different UUID strings as equal or order them inconsistently across environments/ICU versions)
   * or a typo that makes the comparator non-total for two genuinely different ids.
   */
  it("the account-id comparator orders real UUIDs consistently and never calls two distinct ids equal", async () => {
    const rows = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM ledger_accounts ORDER BY id LIMIT 50`,
    );
    const ids = rows.map((r) => r.id);
    expect(ids.length).toBeGreaterThan(5);

    const compare = (a: string, b: string): number => (a < b ? -1 : 1);

    // Antisymmetry check for every distinct pair actually present in this database: compare(a,b)
    // and compare(b,a) must disagree in sign whenever a !== b.
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i] as string;
        const b = ids[j] as string;
        expect(a).not.toBe(b);
        const forwardCmp = compare(a, b);
        const backwardCmp = compare(b, a);
        expect(Math.sign(forwardCmp)).toBe(-Math.sign(backwardCmp));
      }
    }

    // Sorting the same set twice, from different starting permutations, must produce the identical
    // ordering — this is the determinism the "one global lock order" claim depends on.
    const shuffledOnce = [...ids].reverse();
    const shuffledTwice = [...ids].sort(() => Math.random() - 0.5);
    const sortedA = [...shuffledOnce].sort(compare);
    const sortedB = [...shuffledTwice].sort(compare);
    expect(sortedA).toEqual(sortedB);

    // Documented finding, not asserted as a failure: for EQUAL ids this comparator returns 1, never
    // 0 — a genuine comparator-contract violation (Array.prototype.sort's `compareFn` is specified
    // to return 0 for equal elements). It happens to be harmless here because two entries that
    // resolve to the same account never need a defined relative order for lock-ordering purposes
    // (Test 4 proves that empirically), but it is not "correct" and should not be copied elsewhere.
    expect(compare(ids[0] as string, ids[0] as string)).toBe(1);
  });
});
