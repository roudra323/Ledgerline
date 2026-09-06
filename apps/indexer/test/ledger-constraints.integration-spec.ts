import "reflect-metadata";
import { DataSource } from "typeorm";

import { appDataSourceOptions, dataSourceOptions } from "../src/data-source";

/**
 * Proves the deferred balance trigger (Block 1.4) is load-bearing: the database itself
 * refuses to COMMIT a ledger_transaction whose entries don't balance per asset_code.
 */
describe("ledger balance constraint trigger", () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource(dataSourceOptions);
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function createTransaction(causeId: string): Promise<string> {
    const result = await dataSource.query<{ id: string }[]>(
      `INSERT INTO ledger_transactions (kind, cause_type, cause_id)
       VALUES ('onramp.capture', 'test', $1)
       RETURNING id`,
      [causeId],
    );
    const row = result[0];
    if (!row) throw new Error("insert into ledger_transactions returned no row");
    return row.id;
  }

  async function accountId(code: string): Promise<string> {
    const result = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM ledger_accounts WHERE code = $1 AND asset_code = 'USD' LIMIT 1`,
      [code],
    );
    const row = result[0];
    if (!row) throw new Error(`no ledger_accounts row for code ${code}`);
    return row.id;
  }

  it("rejects a transaction whose entries do not balance", async () => {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const transactionId = await createTransaction(`unbalanced-${Date.now()}`);
      const receivable = await accountId("1000");

      // Only one leg of what should be a two-sided entry — debits ≠ credits for USD.
      await queryRunner.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
         VALUES ($1, $2, 'debit', 'USD', 10000, 0)`,
        [transactionId, receivable],
      );

      await expect(queryRunner.commitTransaction()).rejects.toThrow(/unbalanced/i);
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      await queryRunner.release();
    }
  });

  it("accepts a transaction whose entries balance", async () => {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const transactionId = await createTransaction(`balanced-${Date.now()}`);
      const receivable = await accountId("1000");
      const unsettled = await accountId("2100");

      await queryRunner.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
         VALUES ($1, $2, 'debit', 'USD', 10000, 0)`,
        [transactionId, receivable],
      );
      await queryRunner.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
         VALUES ($1, $2, 'credit', 'USD', 10000, 1)`,
        [transactionId, unsettled],
      );

      await expect(queryRunner.commitTransaction()).resolves.toBeUndefined();
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      await queryRunner.release();
    }
  });

  /**
   * Posts one committed, balanced transaction to mutate against. Returns its id and its first
   * entry's id. Both entries must land in ONE transaction — the balance trigger is deferred to
   * COMMIT, so inserting them as two separate autocommit statements would let the first one
   * commit alone and trip the Block 1.4 trigger before the second leg ever exists.
   */
  async function postBalancedTransaction(): Promise<{ transactionId: string; entryId: string }> {
    const receivable = await accountId("1000");
    const unsettled = await accountId("2100");

    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const txResult = (await queryRunner.query(
        `INSERT INTO ledger_transactions (kind, cause_type, cause_id)
         VALUES ('onramp.capture', 'test', $1)
         RETURNING id`,
        [`immutable-${Date.now()}-${Math.random()}`],
      )) as { id: string }[];
      const txRow = txResult[0];
      if (!txRow) throw new Error("insert into ledger_transactions returned no row");
      const transactionId = txRow.id;

      const entryResult = (await queryRunner.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
         VALUES ($1, $2, 'debit', 'USD', 10000, 0)
         RETURNING id`,
        [transactionId, receivable],
      )) as { id: string }[];
      await queryRunner.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
         VALUES ($1, $2, 'credit', 'USD', 10000, 1)`,
        [transactionId, unsettled],
      );

      await queryRunner.commitTransaction();

      const entryRow = entryResult[0];
      if (!entryRow) throw new Error("insert into ledger_entries returned no row");
      return { transactionId, entryId: entryRow.id };
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      await queryRunner.release();
    }
  }

  describe("immutability trigger", () => {
    it("rejects UPDATE on ledger_entries", async () => {
      const { entryId } = await postBalancedTransaction();

      await expect(
        dataSource.query(`UPDATE ledger_entries SET amount_minor = 1 WHERE id = $1`, [entryId]),
      ).rejects.toThrow(/immutable/i);
    });

    it("rejects DELETE on ledger_entries", async () => {
      const { entryId } = await postBalancedTransaction();

      await expect(
        dataSource.query(`DELETE FROM ledger_entries WHERE id = $1`, [entryId]),
      ).rejects.toThrow(/immutable/i);
    });

    it("rejects UPDATE on ledger_transactions", async () => {
      const { transactionId } = await postBalancedTransaction();

      await expect(
        dataSource.query(`UPDATE ledger_transactions SET metadata = '{}' WHERE id = $1`, [
          transactionId,
        ]),
      ).rejects.toThrow(/immutable/i);
    });

    it("rejects DELETE on ledger_transactions", async () => {
      const { transactionId } = await postBalancedTransaction();

      await expect(
        dataSource.query(`DELETE FROM ledger_transactions WHERE id = $1`, [transactionId]),
      ).rejects.toThrow(/immutable/i);
    });
  });

  describe("least-privilege app role", () => {
    let appDataSource: DataSource;

    beforeAll(async () => {
      appDataSource = new DataSource(appDataSourceOptions);
      await appDataSource.initialize();
    });

    afterAll(async () => {
      await appDataSource.destroy();
    });

    it("cannot UPDATE ledger_entries even before the trigger runs — REVOKE, not just the trigger, blocks it", async () => {
      const { entryId } = await postBalancedTransaction();

      await expect(
        appDataSource.query(`UPDATE ledger_entries SET amount_minor = 1 WHERE id = $1`, [entryId]),
      ).rejects.toThrow(/permission denied/i);
    });

    it("can still SELECT and INSERT as the app role", async () => {
      const receivable = await accountId("1000");
      const unsettled = await accountId("2100");

      // Both entries in one transaction — same reason as postBalancedTransaction: the
      // deferred balance trigger only sees all of a transaction's legs at COMMIT.
      const queryRunner = appDataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      let transactionId: string;
      try {
        const txResult = (await queryRunner.query(
          `INSERT INTO ledger_transactions (kind, cause_type, cause_id)
           VALUES ('onramp.capture', 'test', $1)
           RETURNING id`,
          [`app-role-${Date.now()}`],
        )) as { id: string }[];
        const txRow = txResult[0];
        if (!txRow) throw new Error("insert into ledger_transactions returned no row");
        transactionId = txRow.id;

        await queryRunner.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
           VALUES ($1, $2, 'debit', 'USD', 100, 0)`,
          [transactionId, receivable],
        );
        await queryRunner.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
           VALUES ($1, $2, 'credit', 'USD', 100, 1)`,
          [transactionId, unsettled],
        );

        await queryRunner.commitTransaction();
      } finally {
        if (queryRunner.isTransactionActive) {
          await queryRunner.rollbackTransaction();
        }
        await queryRunner.release();
      }

      const rows = await appDataSource.query<{ id: string }[]>(
        `SELECT id FROM ledger_entries WHERE transaction_id = $1`,
        [transactionId],
      );
      expect(rows).toHaveLength(2);
    });
  });

  /**
   * docs/architecture.md §2.2 / ADR-0004 describe the balance trigger as enforcing THREE things:
   * immutability, balance, and non-negative. Block 1.4's original migration only implemented the
   * first two — 1754006400004-LedgerNonNegativeCheck.ts closes that gap.
   */
  describe("non-negative constraint", () => {
    /** Inserts a fresh, isolated account with a known allows_negative flag and zero history. */
    async function createTestAccount(allowsNegative: boolean): Promise<string> {
      const result = await dataSource.query<{ id: string }[]>(
        `INSERT INTO ledger_accounts (code, name, account_type, normal_side, asset_code, owner_type, owner_id, allows_negative)
         VALUES ($1, 'test_non_negative_guard', 'asset', 'debit', 'USD', 'customer', gen_random_uuid(), $2)
         RETURNING id`,
        [`test-${Date.now()}-${Math.random()}`, allowsNegative],
      );
      const row = result[0];
      if (!row) throw new Error("insert into ledger_accounts returned no row");
      return row.id;
    }

    /**
     * Posts one balanced USD transaction that credits `targetAccountId` — a decrease, since its
     * normal_side is 'debit' — against a real platform account, inside one transaction.
     */
    async function creditAccount(targetAccountId: string, amountMinor: number): Promise<void> {
      const counterparty = await accountId("2100");
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        const transactionId = await createTransaction(`negative-check-${Date.now()}-${Math.random()}`);
        await queryRunner.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
           VALUES ($1, $2, 'debit', 'USD', $3, 0)`,
          [transactionId, counterparty, amountMinor],
        );
        await queryRunner.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, asset_code, amount_minor, sequence)
           VALUES ($1, $2, 'credit', 'USD', $3, 1)`,
          [transactionId, targetAccountId, amountMinor],
        );
        await queryRunner.commitTransaction();
      } finally {
        if (queryRunner.isTransactionActive) {
          await queryRunner.rollbackTransaction();
        }
        await queryRunner.release();
      }
    }

    it("rejects a transaction that drives an allows_negative=false account below zero", async () => {
      const guardedAccount = await createTestAccount(false);

      await expect(creditAccount(guardedAccount, 100)).rejects.toThrow(/allows_negative = false/i);
    });

    it("allows an allows_negative=true account (fx_clearing) to go negative", async () => {
      const fxClearingUsd = await accountId("1800");

      await expect(creditAccount(fxClearingUsd, 50)).resolves.toBeUndefined();
    });
  });
});
