import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The foundation the whole ledger sits on: the asset registry and the chart of accounts.
 *
 * Two rules this migration exists to enforce (docs/decisions/0001-money-representation.md):
 *   1. Scale belongs to the ASSET, never to a row. `assets.decimals` is the single registry.
 *   2. Every amount is an integer in the minor unit — `numeric(38,0)`, never a float, never a
 *      scaled decimal. `numeric` (not `int8`) because an 18-decimal token overflows a bigint.
 *
 * Account codes follow the conventional accounting ranges so the chart reads like a real one:
 *   1xxx assets · 2xxx liabilities · 3xxx equity · 4xxx revenue · 5xxx expenses · 9xxx losses.
 */
export class AssetsAndChartOfAccounts1754006400000 implements MigrationInterface {
  name = "AssetsAndChartOfAccounts1754006400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // ── assets ────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE assets (
        asset_code    text        PRIMARY KEY,
        kind          text        NOT NULL CHECK (kind IN ('fiat', 'token', 'native')),
        decimals      smallint    NOT NULL CHECK (decimals BETWEEN 0 AND 18),
        chain_id      integer     NULL,
        token_address bytea       NULL CHECK (token_address IS NULL OR octet_length(token_address) = 20),
        is_active     boolean     NOT NULL DEFAULT true,
        created_at    timestamptz NOT NULL DEFAULT now(),
        -- fiat has no chain; everything else does
        CONSTRAINT assets_chain_matches_kind CHECK ((kind = 'fiat') = (chain_id IS NULL))
      )
    `);

    // Partial: many assets may have a NULL token_address (fiat, native), but a deployed token
    // address must be unique per chain.
    await queryRunner.query(`
      CREATE UNIQUE INDEX assets_chain_token_uk ON assets (chain_id, token_address)
        WHERE token_address IS NOT NULL
    `);

    await queryRunner.query(`
      INSERT INTO assets (asset_code, kind, decimals, chain_id) VALUES
        ('USD',  'fiat',   2, NULL),
        ('USDX', 'token',  6, 31337),
        ('ETH',  'native', 18, 31337)
    `);

    // ── ledger_accounts ───────────────────────────────────────────────────────
    // Statuses and types are text + CHECK, never PG enums — see ADR-0014.
    await queryRunner.query(`
      CREATE TABLE ledger_accounts (
        id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        code            text        NOT NULL,
        name            text        NOT NULL,
        account_type    text        NOT NULL
                          CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
        normal_side     text        NOT NULL CHECK (normal_side IN ('debit','credit')),
        asset_code      text        NOT NULL REFERENCES assets (asset_code),
        owner_type      text        NOT NULL CHECK (owner_type IN ('platform','merchant','customer')),
        owner_id        uuid        NULL,
        allows_negative boolean     NOT NULL DEFAULT false,
        is_active       boolean     NOT NULL DEFAULT true,
        created_at      timestamptz NOT NULL DEFAULT now(),
        -- platform accounts are singletons; per-counterparty accounts must name their owner
        CONSTRAINT ledger_accounts_owner_matches_type CHECK ((owner_type = 'platform') = (owner_id IS NULL))
      )
    `);

    // One account per (code, asset, owner). NULLS NOT DISTINCT so two platform accounts with the
    // same code and asset collide as intended — without it, NULL owner_id would let duplicates in.
    await queryRunner.query(`
      CREATE UNIQUE INDEX ledger_accounts_identity_uk
        ON ledger_accounts (code, asset_code, owner_type, owner_id) NULLS NOT DISTINCT
    `);
    await queryRunner.query(`
      CREATE INDEX ledger_accounts_owner_idx ON ledger_accounts (owner_type, owner_id)
        WHERE owner_id IS NOT NULL
    `);

    // ── the platform chart of accounts ────────────────────────────────────────
    // Per-merchant accounts (1300, 2000, 2010, 2200) are created on merchant onboarding, not here.
    await queryRunner.query(`
      INSERT INTO ledger_accounts (code, name, account_type, normal_side, asset_code, owner_type, allows_negative) VALUES
        ('1000', 'psp_receivable',     'asset',     'debit',  'USD',  'platform', false),
        ('1010', 'bank_settlement',    'asset',     'debit',  'USD',  'platform', false),
        ('1100', 'token_treasury',     'asset',     'debit',  'USDX', 'platform', false),
        ('1150', 'token_in_transit',   'asset',     'debit',  'USDX', 'platform', false),
        ('1200', 'gas_wallet',         'asset',     'debit',  'ETH',  'platform', false),
        ('1800', 'fx_clearing',        'equity',    'debit',  'USD',  'platform', true),
        ('1810', 'fx_clearing',        'equity',    'debit',  'USDX', 'platform', true),
        ('2100', 'unsettled_capture',  'liability', 'credit', 'USD',  'platform', false),
        ('2500', 'stablecoin_issued',  'liability', 'credit', 'USDX', 'platform', false),
        ('3900', 'rounding_residual',  'equity',    'credit', 'USD',  'platform', true),
        ('3900', 'rounding_residual',  'equity',    'credit', 'USDX', 'platform', true),
        ('3900', 'rounding_residual',  'equity',    'credit', 'ETH',  'platform', true),
        ('4000', 'fee_revenue',        'revenue',   'credit', 'USD',  'platform', false),
        ('5000', 'psp_fee_expense',    'expense',   'debit',  'USD',  'platform', false),
        ('5010', 'gas_expense',        'expense',   'debit',  'ETH',  'platform', false),
        ('9000', 'chargeback_loss',    'expense',   'debit',  'USD',  'platform', false)
    `);

    // The FX clearing pair and the rounding sink are the only accounts allowed to go negative:
    // they are transient by nature and must never block a posting. Everything else that overdraws
    // is a bug we want surfaced at COMMIT.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ledger_accounts`);
    await queryRunner.query(`DROP TABLE IF EXISTS assets`);
  }
}
