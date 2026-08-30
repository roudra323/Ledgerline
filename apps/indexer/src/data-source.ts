import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import "reflect-metadata";
import { DataSource, type DataSourceOptions } from "typeorm";

import { validateEnv } from "./config/env.schema";

/**
 * Ensure environment variables from root `.env` are loaded into process.env
 * when running standalone CLI commands (e.g. typeorm migration:run).
 */
const rootEnvPath = resolve(__dirname, "../../../.env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) {
  const envContent = readFileSync(rootEnvPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed
        .slice(eqIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

/**
 * Validate environment variables using the single source of truth Zod schema (env.schema.ts).
 * Fails loud at startup if any required environment variable is missing or invalid.
 */
const env = validateEnv(process.env);

/**
 * Standalone TypeORM DataSource — used by the CLI for migration:generate / migration:run.
 *
 * Connects as the table-owning role (`DATABASE_URL`). Owners always bypass Postgres
 * REVOKE, which is exactly why the running app must NOT use this DataSource — see
 * `appDataSourceOptions` below and Block 1.5's immutability migration.
 *
 * Entities live under several modules (ledger, sagas, fiat, chain-writer, blockchain), so the
 * glob spans them all. Migrations are shared and live at `src/migrations`.
 */
export const dataSourceOptions: DataSourceOptions = {
  type: "postgres",
  url: env.DATABASE_URL,
  entities: [__dirname + "/**/entities/*.entity.{ts,js}"],
  migrations: [__dirname + "/migrations/*.{ts,js}"],
  synchronize: false, // always false — use migrations. See docs/conventions.md section 9.
  logging: ["error", "warn"],
};

export const AppDataSource = new DataSource(dataSourceOptions);

/**
 * Options for TypeOrmModule.forRoot() in AppModule — the connection the running app actually
 * uses. Connects as the least-privilege `ledgerline_app` role (`APP_DATABASE_URL`), which
 * cannot UPDATE or DELETE ledger_entries/ledger_transactions at the database level, regardless
 * of what application code does or forgets to do.
 */
export const appDataSourceOptions: DataSourceOptions = {
  ...dataSourceOptions,
  url: env.APP_DATABASE_URL,
};
