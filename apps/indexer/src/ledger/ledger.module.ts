import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AccountRegistryService } from "./account-registry.service";
import { Asset } from "./entities/asset.entity";
import { LedgerAccountBalance } from "./entities/ledger-account-balance.entity";
import { LedgerAccount } from "./entities/ledger-account.entity";
import { LedgerEntry } from "./entities/ledger-entry.entity";
import { LedgerTransaction } from "./entities/ledger-transaction.entity";
import { LedgerService } from "./ledger.service";

/**
 * LedgerModule — the double-entry ledger engine.
 *
 * The ONLY module permitted to write `ledger_transactions` and `ledger_entries`.
 * All other modules (Sagas, Ingest, Compliance) call LedgerService.post().
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Asset,
      LedgerAccount,
      LedgerTransaction,
      LedgerEntry,
      LedgerAccountBalance,
    ]),
  ],
  providers: [AccountRegistryService, LedgerService],
  exports: [TypeOrmModule, AccountRegistryService, LedgerService],
})
export class LedgerModule {}
