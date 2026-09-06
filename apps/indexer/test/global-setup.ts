import { DataSource } from "typeorm";

import { createTestDatabase, requireEnv, testDatabaseName } from "./database-fixture";

/**
 * Jest globalSetup: build a fresh database and migrate it, so the suite proves the migrations
 * actually apply from nothing on every run — not just that they applied once, months ago, on a
 * developer's laptop.
 */
export default async function globalSetup(): Promise<void> {
  const ownerUrl = requireEnv("DATABASE_URL");
  const databaseName = testDatabaseName();

  // Stashed for teardown: createTestDatabase rewrites the environment to point at the new database.
  const globalState = globalThis as { __LEDGERLINE_TEST_DB__?: { name: string; ownerUrl: string } };
  globalState.__LEDGERLINE_TEST_DB__ = { name: databaseName, ownerUrl };
  process.env.LEDGERLINE_TEST_DATABASE = databaseName;
  process.env.LEDGERLINE_TEST_OWNER_URL = ownerUrl;

  await createTestDatabase(databaseName);

  // Imported only now: src/data-source.ts reads and validates the environment at import time, and
  // it must see the rewritten URLs. Migrations run as the owning role, not ledgerline_app.
  const { dataSourceOptions } = await import("../src/data-source");
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}
