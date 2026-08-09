import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import "reflect-metadata";
import { DataSource, type DataSourceOptions } from "typeorm";

// Load root .env file using Node built-in fs if running via TypeORM CLI
const envPath = resolve(__dirname, "../../../.env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

/**
 * Standalone TypeORM DataSource — used by the CLI for migration:generate / migration:run,
 * and its `options` are reused by TypeOrmModule.forRoot in AppModule.
 *
 * Entities live under several modules now (ledger, sagas, fiat, chain-writer, blockchain), so the
 * glob spans them all. Migrations are shared and live at `src/migrations`.
 *
 * TODO(Phase 1): entity files land module by module; the glob already covers them.
 */
export const dataSourceOptions: DataSourceOptions = {
  type: "postgres",
  ...(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : {}),
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? "ledgerline",
  password: process.env.POSTGRES_PASSWORD ?? "ledgerline",
  database: process.env.POSTGRES_DB ?? "ledgerline",
  entities: [__dirname + "/**/entities/*.entity.{ts,js}"],
  migrations: [__dirname + "/migrations/*.{ts,js}"],
  synchronize: false, // always false — use migrations. See docs/conventions.md section 9.
  logging: ["error", "warn"],
};

export const AppDataSource = new DataSource(dataSourceOptions);
