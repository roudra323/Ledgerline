import "reflect-metadata";
import { DataSource, type DataSourceOptions } from "typeorm";

/**
 * Standalone TypeORM DataSource — used by the CLI for migration:generate / migration:run,
 * and its `options` are reused by TypeOrmModule.forRoot in AppModule.
 *
 * TODO(Phase 1): register entities + migrations globs once the entity files are implemented.
 */
export const dataSourceOptions: DataSourceOptions = {
  type: "postgres",
  ...(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : {}),
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? "chainstake",
  password: process.env.POSTGRES_PASSWORD ?? "chainstake",
  database: process.env.POSTGRES_DB ?? "chainstake",
  entities: [__dirname + "/entities/*.entity.{ts,js}"],
  migrations: [__dirname + "/migrations/*.{ts,js}"],
  synchronize: false, // always false — use migrations.
  logging: ["error", "warn"],
};

export const AppDataSource = new DataSource(dataSourceOptions);
