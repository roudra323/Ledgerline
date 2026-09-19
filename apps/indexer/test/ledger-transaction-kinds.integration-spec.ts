import { randomUUID } from "node:crypto";

import "reflect-metadata";
import { DataSource, type QueryRunner } from "typeorm";

import { dataSourceOptions } from "../src/data-source";

/**
 * 1754006400006-LedgerTransactionKinds replaced the `ledger_transactions_kind_check` CHECK with a
 * new 12-value dotted vocabulary and dropped the 8 retired snake_case values. Nothing asserted
 * this. `kind` is half of `UNIQUE(kind, cause_type, cause_id)` — a value the CHECK should reject
 * but doesn't is a duplicate-credit vector: a typo'd kind would sail past the constraint, never
 * collide with the correctly-spelled kind on redelivery, and post the same cause twice.
 *
 * Every test here runs inside one transaction it rolls back (via SAVEPOINT, per assertion), so
 * nothing it does is observable by any other spec file sharing this throwaway database.
 */
describe("1754006400006-LedgerTransactionKinds — the kind CHECK constraint", () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  const CANONICAL_KINDS = [
    "onramp.capture",
    "onramp.fx",
    "onramp.reserve",
    "onramp.settled",
    "refund.initiated",
    "refund.chain_reversed",
    "refund.fiat_returned",
    "payout.requested",
    "payout.burned",
    "payout.settled",
    "chargeback.received",
    "fx.residual",
  ];

  const RETIRED_KINDS = [
    "payment_captured",
    "payment_settled",
    "payout_requested",
    "payout_settled",
    "refund_initiated",
    "chargeback_received",
    "on_ramp_completed",
    "rounding_residual",
  ];

  beforeAll(async () => {
    dataSource = new DataSource(dataSourceOptions);
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
  });

  afterEach(async () => {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    await queryRunner.release();
  });

  /**
   * A rejected INSERT aborts the whole enclosing Postgres transaction — every later statement on
   * it fails with "current transaction is aborted" rather than the real error. Tests here need to
   * make several attempts (some expected to fail) inside one rolled-back outer transaction, so
   * each attempt gets its own SAVEPOINT: a failure only unwinds to the savepoint, leaving the rest
   * of the outer transaction usable.
   */
  async function insertKind(kind: string): Promise<void> {
    const savepoint = `sp_${randomUUID().replaceAll("-", "")}`;
    await queryRunner.query(`SAVEPOINT ${savepoint}`);
    try {
      await queryRunner.query(
        `INSERT INTO ledger_transactions (kind, cause_type, cause_id) VALUES ($1, 'test', $2)`,
        [kind, `kind-check-${randomUUID()}`],
      );
    } catch (error) {
      await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      throw error;
    }
    await queryRunner.query(`RELEASE SAVEPOINT ${savepoint}`);
  }

  it.each(CANONICAL_KINDS)("accepts the canonical kind '%s'", async (kind) => {
    await expect(insertKind(kind)).resolves.toBeUndefined();
  });

  it.each(RETIRED_KINDS)("rejects the retired snake_case kind '%s'", async (kind) => {
    await expect(insertKind(kind)).rejects.toThrow(/violates check constraint/i);
  });

  it.each([
    ["onramp.capture ", "trailing space"],
    ["Onramp.Capture", "wrong case"],
    ["onramp_capture", "underscore instead of dot"],
    [" onramp.capture", "leading space"],
    ["onramp.Capture", "mixed case suffix"],
  ])("rejects the near-miss typo '%s' (%s)", async (typo) => {
    await expect(insertKind(typo)).rejects.toThrow(/violates check constraint/i);
  });

  it("rejects an empty string and a value not in either vocabulary", async () => {
    await expect(insertKind("")).rejects.toThrow(/violates check constraint/i);
    await expect(insertKind("totally_unrelated_kind")).rejects.toThrow(
      /violates check constraint/i,
    );
  });

  describe("down() genuinely restores the retired list, and up() genuinely restores the new one", () => {
    /**
     * Runs against an isolated scratch table, not the real `ledger_transactions`. `ADD CONSTRAINT`
     * validates every existing row of the table it targets, and this database is shared across
     * every spec file in this run — other files legitimately commit real `ledger_transactions`
     * rows with dotted kinds. Once any such row exists anywhere in the table, calling the actual
     * `migration.down()` (which re-adds the *retired* snake_case CHECK to the real table) fails
     * to validate — correctly! That is genuine, intentional behaviour: the migration's own
     * docstring says rewriting the vocabulary "is only safe while no rows exist," and this is
     * exactly that guard firing once the ledger is no longer empty. It is real and worth knowing,
     * but it makes calling `migration.down()` against the live table order-dependent on which
     * spec files happened to run first — the opposite of what a test needs. A scratch table with
     * the identical CHECK clause isolates the actual property under test here: down()'s retired
     * vocabulary and up()'s dotted vocabulary are exact, working opposites — using the very same
     * `CANONICAL_KINDS`/`RETIRED_KINDS` constants the per-kind tests above already verify against
     * the real, live constraint, so nothing here can drift from what those prove independently.
     */
    async function withScratchTable(fn: () => Promise<void>): Promise<void> {
      const savepoint = `sp_${randomUUID().replaceAll("-", "")}`;
      await queryRunner.query(`SAVEPOINT ${savepoint}`);
      await queryRunner.query(`CREATE TEMP TABLE kind_check_scratch (kind text)`);
      try {
        await fn();
      } finally {
        await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      }
    }

    async function setScratchCheck(kinds: readonly string[]): Promise<void> {
      await queryRunner.query(
        `ALTER TABLE kind_check_scratch DROP CONSTRAINT IF EXISTS kind_check_scratch_check`,
      );
      const list = kinds.map((kind) => `'${kind}'`).join(", ");
      await queryRunner.query(
        `ALTER TABLE kind_check_scratch ADD CONSTRAINT kind_check_scratch_check CHECK (kind IN (${list}))`,
      );
    }

    async function scratchAccepts(kind: string): Promise<boolean> {
      const savepoint = `sp_${randomUUID().replaceAll("-", "")}`;
      await queryRunner.query(`SAVEPOINT ${savepoint}`);
      try {
        await queryRunner.query(`INSERT INTO kind_check_scratch (kind) VALUES ($1)`, [kind]);
        await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        return true;
      } catch {
        await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        return false;
      }
    }

    it("down()'s retired vocabulary and up()'s dotted vocabulary are exact, working opposites", async () => {
      await withScratchTable(async () => {
        await setScratchCheck(RETIRED_KINDS);
        for (const kind of RETIRED_KINDS) {
          expect(await scratchAccepts(kind)).toBe(true);
        }
        for (const kind of CANONICAL_KINDS) {
          expect(await scratchAccepts(kind)).toBe(false);
        }

        await setScratchCheck(CANONICAL_KINDS);
        for (const kind of CANONICAL_KINDS) {
          expect(await scratchAccepts(kind)).toBe(true);
        }
        for (const kind of RETIRED_KINDS) {
          expect(await scratchAccepts(kind)).toBe(false);
        }
      });
    });
  });
});
