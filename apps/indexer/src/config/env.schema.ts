import { isAddress, zeroAddress } from "viem";
import { z } from "zod";

// Reused by the contract-address env vars added in Phase 3/4.
export const strictAddressSchema = z
  .string()
  .refine((val) => isAddress(val, { strict: true }), {
    message: "Address fails strict EIP-55 checksum check",
  })
  .refine((val) => val !== zeroAddress, { message: "Zero address is not allowed" });

// Environment Variables Schema
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  INDEXER_PORT: z.coerce.number().int().positive().default(3001),
  // No default: a missing DATABASE_URL must crash boot, never silently hit localhost.
  DATABASE_URL: z
    .url({
      message: "DATABASE_URL is required to start the indexer service",
    })
    .min(1, "DATABASE_URL cannot be empty"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

// Export inferred type for the ConfigModule token.
export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return result.data;
}
