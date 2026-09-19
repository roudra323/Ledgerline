import "reflect-metadata";
import type { ContractName, OnChainEventName } from "@ledgerline/shared";

export const ON_CHAIN_EVENT = Symbol("ledgerline:on-chain-event");

export interface OnChainEventMeta {
  readonly contract: ContractName;
  readonly event: OnChainEventName;
}

/**
 * Marks a class as the handler for exactly one on-chain event. EventRegistry discovers these at
 * boot via Nest DiscoveryService and validates loudly: a duplicate handler, or a handler for an
 * event not in the registry, CRASHES STARTUP. Config errors fail at boot; runtime errors isolate.
 *
 * TODO(Part 4): EventRegistry consumes this metadata.
 */
export function OnChainEvent(meta: OnChainEventMeta): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(ON_CHAIN_EVENT, meta, target);
  };
}
