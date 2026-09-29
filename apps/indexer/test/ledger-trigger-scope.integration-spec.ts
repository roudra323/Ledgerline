import { randomUUID } from "node:crypto";

import "reflect-metadata";
import { DataSource, type QueryRunner } from "typeorm";

import { dataSourceOptions } from "../src/data-source";
import {
  LedgerNegativeBalanceError,
  LedgerUnbalancedError,
  toLedgerError,
} from "../src/ledger/ledger-errors";
import { LedgerTriggerScopeAndErrorCodes1754006400009 } from "../src/migrations/1754006400009-LedgerTriggerScopeAndErrorCodes";

/**
 * Attacks the three claims migration 1754006400009 / ADR-0019 make about
 * `assert_transaction_balances()`:
 *
 *   1. The row lock (and the history scan behind it) applies ONLY to accounts with
 *      `allows_negative = false` — an account that may go negative is never locked.
 *   2. An unbalanced transaction raises SQLSTATE LL001; a floor breach raises LL002.
 *   3. `down()` restores 1754006400007's behavior exactly: every account is locked regardless of
 *      `allows_negative`, and rejections carry no custom SQLSTATE.
 *
 * Runs as the owning role (`dataSourceOptions`), not the app role: `FOR NO KEY UPDATE` requires
 * UPDATE privilege on `ledger_accounts`, which `ledgerline_app` deliberately does not have, and
 * `CREATE OR REPLACE FUNCTION` for the down()/up() round trip requires ownership.
 */
describe("assert_transaction_balances() — trigger scope and error codes (migration 1754006400009)", () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource(dataSourceOptions);
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  /** A fresh, disposable, customer-owned USD account with a known allows_negative flag. */
  async function createTestAccount(allowsNegative: boolean): Promise<string> {
    const rows = await dataSource.query<{ id: string }[]>(
      `INSERT INTO ledger_accounts (code, name, account_type, normal_side, asset_code, owner_type, owner_id, allows_negative)
       VALUES ($1, 'test_trigger_scope', 'asset', 'debit', 'USD', 'customer', gen_random_uuid(), $2)
       RETURNING id`,
      [`test-scope-${randomUUID()}`, allowsNegative],
    );
    const row = rows[0];
    if (!row) throw new Error("insert into ledger_accounts returned no row");
    return row.id;
  }

  async function createTransactionHeader(
    queryRunner: QueryRunner,
    causeId: string,
  ): Promise<string> {
    const rows = (await queryRunner.query(
      `INSERT INTO ledger_transactions (kind, cause_type, cause_id) VALUES ('onramp.capture', 'test', $1) RETURNING id`,
      [causeId],
    )) as { id: string }[];
    const row = rows[0];
    if (!row) throw new Error("insert into ledger_transactions returned no row");
    return row.id;
  }

  /** Inserts both legs of a balanced two-account transaction in ONE statement (one firing per row). */
  async function insertBalancedPair(
    queryRunner: QueryRunner,
    transactionId: string,
    debitedAccountId: string,
    creditedAccountId: string,
    amountMinor = 100,
  ): Promise<void> {
    await queryRunner.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
       VALUES ($1, $2, 'debit', 'USD', $4, 0), ($1, $3, 'credit', 'USD', $4, 1)`,
      [transactionId, debitedAccountId, creditedAccountId, amountMinor],
    );
  }

  /**
   * Opens its own connection and attempts a non-blocking row lock, reporting whether it succeeded
   * instead of hanging — the deterministic alternative the brief asks for instead of timing.
   */
  async function attemptNowaitLock(
    accountId: string,
  ): Promise<{ acquired: boolean; error?: Error }> {
    const probe = dataSource.createQueryRunner();
    await probe.connect();
    await probe.startTransaction();
    try {
      await probe.query(`SELECT id FROM ledger_accounts WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, [
        accountId,
      ]);
      return { acquired: true };
    } catch (error) {
      return { acquired: false, error: error as Error };
    } finally {
      if (probe.isTransactionActive) await probe.rollbackTransaction();
      await probe.release();
    }
  }

  describe("lock scope", () => {
    it("never locks an allows_negative=true account's row — no floor, no lock", async () => {
      const underTest = await createTestAccount(true);
      const counterparty = await createTestAccount(true);

      const holder = dataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      try {
        // Forces the deferred constraint trigger to run now, inside this still-open transaction,
        // instead of only at COMMIT — the row lock (if any) is what we are about to probe for.
        await holder.query("SET CONSTRAINTS ALL IMMEDIATE");
        const transactionId = await createTransactionHeader(
          holder,
          `scope-unlocked-${randomUUID()}`,
        );
        await insertBalancedPair(holder, transactionId, underTest, counterparty);

        const probe = await attemptNowaitLock(underTest);
        expect(probe.acquired).toBe(true);
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction();
        await holder.release();
      }
    });

    it("locks an allows_negative=false account's row for the life of the transaction", async () => {
      const underTest = await createTestAccount(false);
      const counterparty = await createTestAccount(true);

      const holder = dataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      try {
        await holder.query("SET CONSTRAINTS ALL IMMEDIATE");
        const transactionId = await createTransactionHeader(holder, `scope-locked-${randomUUID()}`);
        // underTest is debited (its normal side), so it never breaches its own floor here — this
        // isolates "is the row locked" from "does the floor check fail".
        await insertBalancedPair(holder, transactionId, underTest, counterparty);

        const probe = await attemptNowaitLock(underTest);
        expect(probe.acquired).toBe(false);
        expect(probe.error?.message).toMatch(/could not obtain lock/i);
      } finally {
        if (holder.isTransactionActive) await holder.rollbackTransaction();
        await holder.release();
      }

      // The lock must not outlive the transaction: once rolled back, the same probe succeeds.
      const afterRollback = await attemptNowaitLock(underTest);
      expect(afterRollback.acquired).toBe(true);
    });
  });

  describe("SQLSTATEs", () => {
    it("raises LL001 for an unbalanced transaction — toLedgerError() maps it to LedgerUnbalancedError", async () => {
      const solo = await createTestAccount(true);
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      let caught: unknown;
      try {
        const transactionId = await createTransactionHeader(queryRunner, `ll001-${randomUUID()}`);
        await queryRunner.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
           VALUES ($1, $2, 'debit', 'USD', 100, 0)`,
          [transactionId, solo],
        );
        await queryRunner.commitTransaction();
      } catch (error) {
        caught = error;
      } finally {
        if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }

      expect(caught).toBeDefined();
      expect((caught as Error).message).toMatch(/unbalanced/i);
      expect(toLedgerError(caught)).toBeInstanceOf(LedgerUnbalancedError);
    });

    it("raises LL002 for a non-negative floor breach — toLedgerError() maps it to LedgerNegativeBalanceError", async () => {
      const guarded = await createTestAccount(false);
      const absorber = await createTestAccount(true);
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      let caught: unknown;
      try {
        const transactionId = await createTransactionHeader(queryRunner, `ll002-${randomUUID()}`);
        // guarded is CREDITED (its normal side is debit) — a decrease from zero, breaching the floor.
        await insertBalancedPair(queryRunner, transactionId, absorber, guarded);
        await queryRunner.commitTransaction();
      } catch (error) {
        caught = error;
      } finally {
        if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }

      expect(caught).toBeDefined();
      expect((caught as Error).message).toMatch(/allows_negative = false/i);
      expect(toLedgerError(caught)).toBeInstanceOf(LedgerNegativeBalanceError);
    });
  });

  describe("down() / up() round trip", () => {
    const migration = new LedgerTriggerScopeAndErrorCodes1754006400009();

    it("down() restores locking every account with no custom SQLSTATE; up() restores the scoped, coded version", async () => {
      const owner = dataSource.createQueryRunner();
      await owner.connect();

      try {
        await migration.down(owner);

        // Claim 1 reverted: an allows_negative=true account is locked again under the old function.
        const trueAccount = await createTestAccount(true);
        const counterparty = await createTestAccount(true);
        const holder = dataSource.createQueryRunner();
        await holder.connect();
        await holder.startTransaction();
        try {
          await holder.query("SET CONSTRAINTS ALL IMMEDIATE");
          const transactionId = await createTransactionHeader(
            holder,
            `down-locks-true-${randomUUID()}`,
          );
          await insertBalancedPair(holder, transactionId, trueAccount, counterparty);

          const probe = await attemptNowaitLock(trueAccount);
          expect(probe.acquired).toBe(false);
        } finally {
          if (holder.isTransactionActive) await holder.rollbackTransaction();
          await holder.release();
        }

        // Claim 2 reverted: the floor breach still raises (message unchanged), but with the
        // Postgres default SQLSTATE (P0001), which toLedgerError() must NOT recognise.
        const guarded = await createTestAccount(false);
        const absorber = await createTestAccount(true);
        const qr = dataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        let caught: unknown;
        try {
          const transactionId = await createTransactionHeader(qr, `down-no-code-${randomUUID()}`);
          await insertBalancedPair(qr, transactionId, absorber, guarded);
          await qr.commitTransaction();
        } catch (error) {
          caught = error;
        } finally {
          if (qr.isTransactionActive) await qr.rollbackTransaction();
          await qr.release();
        }

        expect(caught).toBeDefined();
        expect((caught as Error).message).toMatch(/allows_negative = false/i);
        // Unchanged reference: no SQLSTATE this function's own migration owns, so toLedgerError()
        // must be a no-op — proving down() genuinely dropped the LL002 ERRCODE, not just reworded it.
        expect(toLedgerError(caught)).toBe(caught);
      } finally {
        // Always restore the scoped, coded version — every other integration spec file in this run
        // shares this same database and depends on 1754006400009's behavior being live.
        await migration.up(owner);
        await owner.release();
      }

      // Confirms restoration actually took effect: back to "no lock for allows_negative=true" —
      // proven the same way as the top-level lock-scope tests, with a holder transaction actually
      // inserting against the account, not just an uncontended probe (which would pass regardless
      // of which function version is live).
      const restoredTrueAccount = await createTestAccount(true);
      const restoredCounterparty = await createTestAccount(true);
      const restoredHolder = dataSource.createQueryRunner();
      await restoredHolder.connect();
      await restoredHolder.startTransaction();
      try {
        await restoredHolder.query("SET CONSTRAINTS ALL IMMEDIATE");
        const transactionId = await createTransactionHeader(
          restoredHolder,
          `restored-unlocked-${randomUUID()}`,
        );
        await insertBalancedPair(
          restoredHolder,
          transactionId,
          restoredTrueAccount,
          restoredCounterparty,
        );

        const restoredProbe = await attemptNowaitLock(restoredTrueAccount);
        expect(restoredProbe.acquired).toBe(true);
      } finally {
        if (restoredHolder.isTransactionActive) await restoredHolder.rollbackTransaction();
        await restoredHolder.release();
      }
    });
  });
});
