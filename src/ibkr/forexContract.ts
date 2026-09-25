import type { ForexContract } from "../types.js";

/** One spot FX pair in IBKR `BASE.QUOTE` form. */
export interface ForexPair {
  base: string;
  quote: string;
  localSymbol: string;
}

const exactKeys = new Set(["conid", "assetClass", "symbol", "currency", "localSymbol", "exchange"]);
const currencyCode = /^[A-Z]{3}$/;

/**
 * Parse one exact `BASE.QUOTE` pair, for example `USD.JPY`. Each side must be a three-letter
 * upper-case currency code, and the two sides must be different. Returns `null` for any other
 * input. This function does not normalize other spellings.
 */
export function parseForexPair(input: unknown): ForexPair | null {
  if (typeof input !== "string") return null;
  const match = /^(?<base>[A-Z]{3})\.(?<quote>[A-Z]{3})$/.exec(input);
  const base = match?.groups?.["base"];
  const quote = match?.groups?.["quote"];
  if (base === undefined || quote === undefined || base === quote) return null;
  return { base, quote, localSymbol: `${base}.${quote}` };
}

/** Normalize one complete IDEALPRO spot FX identity without inferring missing contract facts. */
export function normalizeForexContract(input: unknown): ForexContract | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !exactKeys.has(key))) return null;

  const conid = record["conid"];
  const pair = parseForexPair(record["localSymbol"]);
  if (
    !Number.isSafeInteger(conid) ||
    (conid as number) <= 0 ||
    record["assetClass"] !== "CASH" ||
    record["exchange"] !== "IDEALPRO" ||
    pair === null ||
    typeof record["symbol"] !== "string" ||
    !currencyCode.test(record["symbol"]) ||
    record["symbol"] !== pair.base ||
    record["currency"] !== pair.quote
  ) {
    return null;
  }

  return Object.freeze({
    conid: conid as number,
    assetClass: "CASH",
    symbol: pair.base,
    currency: pair.quote,
    localSymbol: pair.localSymbol,
    exchange: "IDEALPRO",
  });
}
