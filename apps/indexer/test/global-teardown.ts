import { dropTestDatabase, requireEnv } from "./database-fixture";

/** Jest globalTeardown: drop the run's database, whether the suite passed or failed. */
export default async function globalTeardown(): Promise<void> {
  await dropTestDatabase(
    requireEnv("LEDGERLINE_TEST_OWNER_URL"),
    requireEnv("LEDGERLINE_TEST_DATABASE"),
  );
}
