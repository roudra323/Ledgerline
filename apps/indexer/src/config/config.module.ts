/**
 * ConfigModule — the only place env vars are read and validated.
 *
 * isGlobal: true  → injectable anywhere, no re-import needed
 * envFilePath     → dev loads .env.local / .env; compose injects env directly in prod
 * validate        → runs zod against the merged env; throws at boot on anything bad
 */
import { Module } from "@nestjs/common";
import { ConfigModule as NestConfigModule } from "@nestjs/config";

import { validateEnv } from "./env.schema";

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.local", ".env"],
      validate: validateEnv,
    }),
  ],
})
export class ConfigModule {}
