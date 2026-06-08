import type { BrokerName } from "../types.js";

/** Stub — order history is not implemented for IBKR yet. */
export function handleOrders(_broker: BrokerName): void {
  throw new Error("`orders` is not implemented yet for IBKR.");
}
