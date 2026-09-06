import { randomUUID } from "node:crypto";

import { Client } from "pg";

/**
 * Creates and destroys a throwaway Postgres database for one integration run.
 *
 * The ledger's log tables are deliberately immutable, so an integration test physically cannot
 * clean up after itself: every run against a shared database accumulates rows forever. That breaks
 * determinism (docs/conventions.md §11) — and it compounds, because the non-negative trigger
 * derives an account's balance by scanning that account's whole history, so the suite also gets
 * slower every time it runs.
 *
 * A fresh database per run makes each suite start from the migrated schema and nothing else.
 */

const TEMPLATE_ENV_KEYS = ["DATABASE_URL", "APP_DATABASE_URL"] as const;

/** Postgres cannot drop the database you are connected to, so DDL runs against `postgres`. */
function maintenanceUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function withDatabase(databaseUrl: string, databaseName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function testDatabaseName(): string {
  return `ledgerline_test_${randomUUID().replaceAll("-", "")}`;
}

async function runOnMaintenance(databaseUrl: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceUrl(databaseUrl) });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(databaseName: string): Promise<void> {
  const ownerUrl = requireEnv("DATABASE_URL");
  await runOnMaintenance(ownerUrl, `CREATE DATABASE "${databaseName}"`);

  // Point every connection string in the environment at the new database before the workers read
  // them — src/data-source.ts validates and freezes these at import time.
  for (const key of TEMPLATE_ENV_KEYS) {
    process.env[key] = withDatabase(requireEnv(key), databaseName);
  }
}

export async function dropTestDatabase(originalOwnerUrl: string, databaseName: string): Promise<void> {
  await runOnMaintenance(
    originalOwnerUrl,
    `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
  );
}

export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `${key} must be set to run integration tests — copy .env.example to .env, or export it in CI`,
    );
  }
  return value;
}
