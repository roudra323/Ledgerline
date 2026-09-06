/**
 * EventRegistryService — discovers @OnChainEvent handlers at boot and routes decoded events.
 *
 * TODO(Part 4):
 *   - use DiscoveryService to scan providers for ON_CHAIN_EVENT metadata.
 *   - boot-time validations that CRASH LOUDLY:
 *       * duplicate handler for the same (contract, event)
 *       * handler registered for an unknown event (not in the ABI/fetch set)
 *   - expose the fetch set (which events to request from getLogs) and dispatch(event).
 * TODO(Part 4): diff registry vs sync_state to auto-create catch-up rows on boot.
 */

export {};
