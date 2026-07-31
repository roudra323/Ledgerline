/**
 * @OnChainEvent — marks a provider method/class as the handler for a specific contract event.
 *
 * Usage (Phase 1):
 *   @OnChainEvent({ contract: "StakingVault", event: "Staked" })
 *   export class StakedHandler { async handle(event: DecodedEvent) { ... } }
 *
 * TODO(Phase 1): implement as a metadata-setting decorator (Reflect.defineMetadata) so
 *   EventRegistryService can discover handlers via Nest DiscoveryService at boot.
 */

export const ON_CHAIN_EVENT = Symbol("chainstake:on-chain-event");

export interface OnChainEventMeta {
  contract: string;
  event: string;
}

export function OnChainEvent(_meta: OnChainEventMeta): ClassDecorator {
  // TODO(Phase 1): Reflect.defineMetadata(ON_CHAIN_EVENT, _meta, target)
  return () => undefined;
}
