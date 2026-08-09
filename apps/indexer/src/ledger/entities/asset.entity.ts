import { Column, Entity, PrimaryColumn } from "typeorm";

import { BaseAuditEntity } from "../../common/entities/base-audit.entity";

export type AssetKind = "fiat" | "token" | "native";

/**
 * Asset Entity — maps the `assets` database table.
 *
 * `assets.decimals` is the single source of truth for currency decimal scaling throughout Ledgerline.
 * Scale belongs to the asset, never to an individual transaction row.
 */
@Entity("assets")
export class Asset extends BaseAuditEntity {
  @PrimaryColumn({ name: "asset_code", type: "text" })
  assetCode!: string;

  @Column({ name: "kind", type: "text" })
  kind!: AssetKind;

  @Column({ name: "decimals", type: "smallint" })
  decimals!: number;

  @Column({ name: "chain_id", type: "integer", nullable: true })
  chainId!: number | null;

  @Column({ name: "token_address", type: "bytea", nullable: true })
  tokenAddress!: Buffer | null;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;
}
