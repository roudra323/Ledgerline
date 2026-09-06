import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, type EntityManager, type QueryRunner } from "typeorm";

import { MetricsService } from "../observability/metrics.service";

import { AccountRegistryService } from "./account-registry.service";
import type { PostingLeg, PostingRequest, PostingResult } from "./ledger.types";

const MIN_LEGS = 2;

/**
 * The single writer of `ledger_transactions`/`ledger_entries` (docs/implementation-guide.md
 * Block 1.6). Every saga and handler posts through this service — nothing else inserts into the
 * ledger tables directly, so every rule (idempotency, balance, immutability) lives in one place.
 *
 * TODO(Block 4.4): `post()` cannot yet construct a reversal. Golden rule 3 says corrections are
 * reversing transactions and `ledger_transactions.reverses_id` exists for them, but `PostingRequest`
 * has no field for it and the INSERT below never sets it — so today the capability is documented and
 * absent. Block 4.4 (reorg reversals) is the first caller that needs it; refunds (8.x) follow.
 */
@Injectable()
export class LedgerService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly accounts: AccountRegistryService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Posts one balanced transaction, or recognises that its cause was already posted.
   *
   * Pass `joinTransaction` to post inside a transaction the caller already owns — a saga's state
   * change and its ledger posting must commit together, or a crash between them leaves a transition
   * with no posting. When it is passed, this method neither commits nor rolls back: the caller's
   * COMMIT is where the deferred balance trigger fires.
   */
  async post(request: PostingRequest, joinTransaction?: QueryRunner): Promise<PostingResult> {
    this.assertPostable(request.entries);

    if (joinTransaction) {
      // Without this guard the promise above is a lie: a QueryRunner that is connected but has no
      // open transaction autocommits every statement, so a posting that fails partway leaves the
      // ledger_transactions header behind with no entries — an orphan the immutability trigger then
      // makes permanent. Fail loudly instead of half-writing the ledger.
      if (!joinTransaction.isTransactionActive) {
        throw new Error(
          "post() was given a QueryRunner with no active transaction — call startTransaction() first, or omit it and let post() manage its own",
        );
      }
      return this.write(joinTransaction, request);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await this.write(queryRunner, request);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /** The write itself, with no opinion about who owns the surrounding transaction. */
  private async write(queryRunner: QueryRunner, request: PostingRequest): Promise<PostingResult> {
    const result = await this.insertTransactionHeader(queryRunner, request);
    if (!result.alreadyPosted) {
      await this.insertEntries(queryRunner, result.transactionId, request.entries);
      this.metrics.recordLedgerEntriesWritten(request.kind, request.entries.length);
    }
    return result;
  }

  /**
   * Mirrors the Block 1.4 database trigger so a bad posting fails here, with a message pointing
   * at the offending leg, instead of only at COMMIT. The trigger remains the real backstop for
   * anything that reaches ledger_entries without going through this function.
   */
  private assertPostable(legs: readonly PostingLeg[]): void {
    if (legs.length < MIN_LEGS) {
      throw new Error(`A posting needs at least ${MIN_LEGS} entries, got ${legs.length}`);
    }

    const residualByAsset = new Map<string, bigint>();
    let index = 0;
    for (const leg of legs) {
      const amount = BigInt(leg.amountMinor);
      if (amount <= 0n) {
        throw new Error(
          `Leg ${index} (${leg.accountCode}): amountMinor must be positive, got ${leg.amountMinor}`,
        );
      }

      const signed = leg.direction === "debit" ? amount : -amount;
      residualByAsset.set(leg.assetCode, (residualByAsset.get(leg.assetCode) ?? 0n) + signed);
      index += 1;
    }

    for (const [assetCode, residual] of residualByAsset) {
      if (residual !== 0n) {
        throw new Error(`Posting is unbalanced in ${assetCode} by ${residual}`);
      }
    }
  }

  /**
   * Inserts the transaction header with `ON CONFLICT (kind, cause_type, cause_id) DO NOTHING`.
   * A conflict means this cause was already posted — expected on webhook redelivery, not an error.
   *
   * The re-select afterwards depends on `READ COMMITTED`, the connection default: a concurrent
   * inserter's uncommitted row makes our INSERT block until it commits, and the fresh snapshot the
   * SELECT then takes sees it. Under `REPEATABLE READ` the SELECT would use the transaction's older
   * snapshot, find nothing, and raise the error below — so do not raise the isolation level here
   * without replacing this with `ON CONFLICT ... DO UPDATE ... RETURNING`.
   */
  private async insertTransactionHeader(
    queryRunner: QueryRunner,
    request: PostingRequest,
  ): Promise<PostingResult> {
    const inserted = (await queryRunner.query(
      `INSERT INTO ledger_transactions (kind, cause_type, cause_id, posted_at, metadata)
       VALUES ($1, $2, $3, COALESCE($4, now()), $5)
       ON CONFLICT (kind, cause_type, cause_id) DO NOTHING
       RETURNING id`,
      [
        request.kind,
        request.cause.type,
        request.cause.id,
        request.postedAt ?? null,
        request.memo ? { memo: request.memo } : null,
      ],
    )) as { id: string }[];

    const insertedRow = inserted[0];
    if (insertedRow) {
      return { transactionId: insertedRow.id, alreadyPosted: false };
    }

    const existing = (await queryRunner.query(
      `SELECT id FROM ledger_transactions WHERE kind = $1 AND cause_type = $2 AND cause_id = $3`,
      [request.kind, request.cause.type, request.cause.id],
    )) as { id: string }[];
    const existingRow = existing[0];
    if (!existingRow) {
      throw new Error(
        `ledger_transactions insert conflicted for cause ${request.cause.type}:${request.cause.id} but no existing row was found`,
      );
    }
    return { transactionId: existingRow.id, alreadyPosted: true };
  }

  private async insertEntries(
    queryRunner: QueryRunner,
    transactionId: string,
    legs: readonly PostingLeg[],
  ): Promise<void> {
    // Resolve first, keeping each leg's caller-order `sequence`. The runner's manager, not the
    // registry's own connection: resolving a leg can CREATE a merchant account, and that creation
    // must live or die with this posting.
    const rows: { accountId: string; leg: PostingLeg; sequence: number }[] = [];
    let sequence = 0;
    for (const leg of legs) {
      rows.push({
        accountId: await this.resolveAccountId(leg, queryRunner.manager),
        leg,
        sequence,
      });
      sequence += 1;
    }

    // Insert in account order, not caller order. The deferred balance trigger fires once per entry
    // in insertion order and locks that entry's account row, so caller order is lock order — and two
    // postings touching the same accounts in opposite orders deadlock. Measured at 87.5% of postings
    // aborting under crossed 20-vs-20 concurrency. Ordering by account id gives every posting made
    // through this service one global lock order, which is the textbook fix. `sequence` is an
    // explicit column, so what it records is unchanged. See ADR-0017.
    const orderedByAccount = [...rows].sort((a, b) => {
      // Ties broken by caller order so the comparator is a proper total order: returning a non-zero
      // value for equal ids violates antisymmetry, which makes the sort's behaviour engine-defined
      // rather than deterministic. Two legs on one account need no particular order between them —
      // the transaction already holds that lock — but a ledger this size should not ship a
      // comparator that is only accidentally correct.
      if (a.accountId === b.accountId) return a.sequence - b.sequence;
      return a.accountId < b.accountId ? -1 : 1;
    });

    for (const row of orderedByAccount) {
      await queryRunner.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          transactionId,
          row.accountId,
          row.leg.direction,
          row.leg.assetCode,
          row.leg.amountMinor,
          row.sequence,
        ],
      );
    }

    // TODO(Block 1.7): update ledger_account_balances here once the row-locked balance repository
    // exists. The deferred trigger already guarantees correctness without it (1754006400007 locks
    // the account row itself) — this only affects the read-side projection.
  }

  private resolveAccountId(leg: PostingLeg, manager: EntityManager): Promise<string> {
    if (leg.merchantId) {
      return this.accounts.resolveMerchantAccount(
        leg.accountCode,
        leg.assetCode,
        leg.merchantId,
        manager,
      );
    }
    return this.accounts.resolvePlatformAccount(leg.accountCode, leg.assetCode, manager);
  }
}
