import type { BrokerName } from "../types.js";

/** Stub — market-data quotes are not implemented for IBKR yet. */
export function handleQuote(_broker: BrokerName, _symbols: string[]): void {
  throw new Error("`quote` is not implemented yet for IBKR.");
}
