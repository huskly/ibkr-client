import type { OptionContract, OptionRight } from "../types.js";

const OSI_PATTERN = /^(.{6})(\d{6})([CP])(\d{8})$/;

export interface ParsedOsiOptionSymbol {
  underlying: string;
  expiry: string;
  strike: number;
  right: OptionRight;
}

function calendarDate(raw: string): string {
  const digits = raw.replace(/-/g, "");
  if (!/^\d{8}$/.test(digits)) throw new Error(`Invalid option expiry: ${raw}`);
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid option expiry: ${raw}`);
  }
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export function formatOsiOptionSymbol(input: {
  underlying: string;
  expiry: string;
  strike: number;
  right: OptionRight;
}): string {
  const underlying = input.underlying.trim().toUpperCase();
  if (!underlying || underlying.length > 6) {
    throw new Error(`OSI underlying must contain 1-6 characters: ${input.underlying}`);
  }
  const expiry = calendarDate(input.expiry).replace(/-/g, "").slice(2);
  const strikeMillis = Math.round(input.strike * 1000);
  if (!Number.isFinite(input.strike) || input.strike <= 0 || strikeMillis > 99_999_999) {
    throw new Error(`Invalid option strike: ${String(input.strike)}`);
  }
  return `${underlying.padEnd(6)}${expiry}${input.right}${String(strikeMillis).padStart(8, "0")}`;
}

export function parseOsiOptionSymbol(symbol: string): ParsedOsiOptionSymbol | null {
  const match = OSI_PATTERN.exec(symbol.toUpperCase());
  if (!match) return null;
  const [, root, date, right, strike] = match;
  if (right === undefined || strike === undefined || root === undefined || date === undefined) {
    return null;
  }
  if (right !== "C" && right !== "P") return null;
  try {
    return {
      underlying: root.trim(),
      expiry: calendarDate(`20${date}`),
      right,
      strike: Number(strike) / 1000,
    };
  } catch {
    return null;
  }
}

export function normalizeOptionContract(input: {
  conid?: number | undefined;
  symbol?: string | undefined;
  /**
   * The IBKR listing class, for example `SPX` or `SPXW`. It names the deliverable, and two classes
   * of one underlying quote the same expiry, strike, and right as different products.
   */
  tradingClass?: string | undefined;
  maturityDate?: string | undefined;
  right?: string | undefined;
  strike?: string | number | undefined;
}): OptionContract | null {
  const right = input.right?.toUpperCase();
  const strike = Number(input.strike);
  if (
    input.conid === undefined ||
    !Number.isSafeInteger(input.conid) ||
    input.conid <= 0 ||
    !input.symbol ||
    !input.maturityDate ||
    (right !== "C" && right !== "P") ||
    !Number.isFinite(strike) ||
    strike <= 0
  ) {
    return null;
  }
  const expiry = calendarDate(input.maturityDate);
  // The OSI root is the listing class, not the underlying. `SPX` and `SPXW` are two deliverables
  // with different settlement, and a root of `SPX` for both makes one identity out of two
  // contracts. A definition with no class reports its underlying, which is what a
  // single-listing name lists.
  const tradingClass = input.tradingClass?.trim().toUpperCase();
  const underlying = input.symbol.trim().toUpperCase();
  const root = tradingClass && tradingClass.length > 0 ? tradingClass : underlying;
  return {
    conid: input.conid,
    underlying,
    tradingClass: root,
    expiry,
    strike,
    right,
    symbol: formatOsiOptionSymbol({
      underlying: root,
      expiry,
      strike,
      right,
    }),
  };
}
