import type { EquityContract } from "../types.js";

const exactKeys = new Set([
  "conid",
  "assetClass",
  "symbol",
  "exchange",
  "primaryExchange",
  "currency",
]);

function normalizedText(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== "string" || /[\r\n\t]/.test(value)) return null;
  const normalized = value.trim().toUpperCase();
  return pattern.test(normalized) ? normalized : null;
}

/** Normalize one complete US equity identity without inferring missing contract facts. */
export function normalizeEquityContract(input: unknown): EquityContract | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !exactKeys.has(key))) return null;

  const conid = record["conid"];
  const symbol = normalizedText(record["symbol"], /^[A-Z0-9][A-Z0-9 .-]{0,31}$/);
  const exchange = normalizedText(record["exchange"], /^[A-Z0-9][A-Z0-9._ -]{0,31}$/);
  const primaryExchange = normalizedText(record["primaryExchange"], /^[A-Z0-9][A-Z0-9._ -]{0,31}$/);
  const currency = normalizedText(record["currency"], /^[A-Z]{3}$/);

  if (
    !Number.isSafeInteger(conid) ||
    (conid as number) <= 0 ||
    record["assetClass"] !== "STK" ||
    symbol === null ||
    exchange !== "SMART" ||
    primaryExchange === null ||
    currency !== "USD"
  ) {
    return null;
  }

  return Object.freeze({
    conid: conid as number,
    assetClass: "STK",
    symbol,
    exchange: "SMART",
    primaryExchange,
    currency: "USD",
  });
}
