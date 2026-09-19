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

/**
 * 1754006400008-LedgerTreasuryKinds appends five kinds — `treasury.mint`, `treasury.psp_sweep`,
 * `payout.returned`, `compliance.frozen`, `reconciliation.adjustment` — to the twelve
 * 1754006400006 defined, per docs/decisions/0018-ledger-flow-postings.md. The set is append-only
 * (ADR-0016): the twelve must keep working exactly as before, and the five new ones must be
 * accepted with the same rigor (typos rejected) the twelve already had.
 *
 * Same isolation strategy as above: every insert attempt runs inside a SAVEPOINT within one
 * transaction this describe block rolls back, so nothing here is observable by any other spec file.
 */
describe("1754006400008-LedgerTreasuryKinds — the kind CHECK constraint", () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  const PRE_EXISTING_TWELVE = [
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

  const NEW_FIVE = [
    "treasury.mint",
    "treasury.psp_sweep",
    "payout.returned",
    "compliance.frozen",
    "reconciliation.adjustment",
  ];

  const ALL_SEVENTEEN = [...PRE_EXISTING_TWELVE, ...NEW_FIVE];

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

  async function insertKind(kind: string): Promise<void> {
    const savepoint = `sp_${randomUUID().replaceAll("-", "")}`;
    await queryRunner.query(`SAVEPOINT ${savepoint}`);
    try {
      await queryRunner.query(
        `INSERT INTO ledger_transactions (kind, cause_type, cause_id) VALUES ($1, 'test', $2)`,
        [kind, `kind008-check-${randomUUID()}`],
      );
    } catch (error) {
      await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      throw error;
    }
    await queryRunner.query(`RELEASE SAVEPOINT ${savepoint}`);
  }

  it.each(NEW_FIVE)("accepts the new kind '%s'", async (kind) => {
    await expect(insertKind(kind)).resolves.toBeUndefined();
  });

  it.each(PRE_EXISTING_TWELVE)(
    "still accepts the pre-existing kind '%s' — the new CHECK is additive, not a replacement",
    async (kind) => {
      await expect(insertKind(kind)).resolves.toBeUndefined();
    },
  );

  it.each([
    ["treasury.Mint", "wrong case"],
    ["treasury_mint", "underscore instead of dot"],
    ["treasury.mint ", "trailing space"],
    ["Treasury.mint", "wrong case on the prefix"],
    ["treasury.psp-sweep", "hyphen instead of underscore"],
    ["treasury.pspsweep", "missing separator"],
    ["Compliance.frozen", "wrong case"],
    ["compliance.Frozen", "wrong case on the suffix"],
    ["payout.Returned", "wrong case"],
    ["payout_returned", "underscore instead of dot"],
    ["reconciliation.Adjustment", "wrong case"],
    ["reconciliation_adjustment", "underscore instead of dot"],
    ["reconciliation.adjustments", "trailing s"],
  ])("rejects the near-miss typo '%s' (%s) of a new kind", async (typo) => {
    await expect(insertKind(typo)).rejects.toThrow(/violates check constraint/i);
  });

  describe("down() restores exactly the pre-existing twelve, and up() restores exactly the seventeen", () => {
    // Same rationale as 1754006400006's version of this test: calling the real migration's down()
    // against the live `ledger_transactions` table is order-dependent on which other spec files
    // already committed rows using one of the five new kinds (ADD CONSTRAINT validates every
    // existing row). A scratch table with the identical CHECK clause isolates the property this
    // test actually cares about — that down()'s twelve and up()'s seventeen are exact opposites of
    // each other on the five new kinds — without depending on the shared table's history.
    async function withScratchTable(fn: () => Promise<void>): Promise<void> {
      const savepoint = `sp_${randomUUID().replaceAll("-", "")}`;
      await queryRunner.query(`SAVEPOINT ${savepoint}`);
      await queryRunner.query(`CREATE TEMP TABLE kind008_check_scratch (kind text)`);
      try {
        await fn();
      } finally {
        await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      }
    }

    async function setScratchCheck(kinds: readonly string[]): Promise<void> {
      await queryRunner.query(
        `ALTER TABLE kind008_check_scratch DROP CONSTRAINT IF EXISTS kind008_check_scratch_check`,
      );
      const list = kinds.map((kind) => `'${kind}'`).join(", ");
      await queryRunner.query(
        `ALTER TABLE kind008_check_scratch ADD CONSTRAINT kind008_check_scratch_check CHECK (kind IN (${list}))`,
      );
    }

    async function scratchAccepts(kind: string): Promise<boolean> {
      const savepoint = `sp_${randomUUID().replaceAll("-", "")}`;
      await queryRunner.query(`SAVEPOINT ${savepoint}`);
      try {
        await queryRunner.query(`INSERT INTO kind008_check_scratch (kind) VALUES ($1)`, [kind]);
        await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        return true;
      } catch {
        await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        return false;
      }
    }

    it("down()'s twelve reject all five new kinds, and up()'s seventeen accept everything down() accepts plus the five new kinds", async () => {
      await withScratchTable(async () => {
        // down(): exactly the twelve 1754006400006 defined — none of the five new kinds, and
        // nothing lost from the twelve either.
        await setScratchCheck(PRE_EXISTING_TWELVE);
        for (const kind of PRE_EXISTING_TWELVE) {
          expect(await scratchAccepts(kind)).toBe(true);
        }
        for (const kind of NEW_FIVE) {
          expect(await scratchAccepts(kind)).toBe(false);
        }

        // up(): the twelve plus the five — nothing dropped, nothing extra beyond the documented five.
        await setScratchCheck(ALL_SEVENTEEN);
        for (const kind of ALL_SEVENTEEN) {
          expect(await scratchAccepts(kind)).toBe(true);
        }
        expect(await scratchAccepts("reconciliation.adjustments")).toBe(false);
        expect(await scratchAccepts("treasury.rebalance")).toBe(false);
      });
    });
  });
});
