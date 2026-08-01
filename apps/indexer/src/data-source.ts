import "reflect-metadata";
import { DataSource, type DataSourceOptions } from "typeorm";

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
