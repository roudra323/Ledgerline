import "reflect-metadata";
import { DataSource } from "typeorm";

import { dataSourceOptions } from "../src/data-source";

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
       VALUES ('payment_captured', 'test', $1)
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
});
