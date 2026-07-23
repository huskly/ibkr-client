import type { OptionContract, OptionRight } from "../types.js";

const OSI_PATTERN = /^(?<root>.{6})(?<date>\d{6})(?<right>[CP])(?<strike>\d{8})$/;

export interface ParsedOsiOptionSymbol {
  underlying: string;
  expiry: string;
  strike: number;
  right: OptionRight;
}

function calendarDate(raw: string): string {
  const digits = raw.replaceAll("-", "");
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
  const expiry = calendarDate(input.expiry).replaceAll("-", "").slice(2);
  const strikeMillis = Math.round(input.strike * 1000);
  if (!Number.isFinite(input.strike) || input.strike <= 0 || strikeMillis > 99_999_999) {
    throw new Error(`Invalid option strike: ${String(input.strike)}`);
  }
  return `${underlying.padEnd(6)}${expiry}${input.right}${String(strikeMillis).padStart(8, "0")}`;
}

export function parseOsiOptionSymbol(symbol: string): ParsedOsiOptionSymbol | null {
  const match = OSI_PATTERN.exec(symbol.toUpperCase());
  const groups = match?.groups;
  if (!groups) return null;
  const right = groups["right"];
  if (right !== "C" && right !== "P") return null;
  try {
    return {
      underlying: (groups["root"] ?? "").trim(),
      expiry: calendarDate(`20${groups["date"] ?? ""}`),
      right,
      strike: Number(groups["strike"]) / 1000,
    };
  } catch {
    return null;
  }
}

export function normalizeOptionContract(input: {
  conid?: number | undefined;
  symbol?: string | undefined;
  maturityDate?: string | undefined;
  right?: string | undefined;
  strike?: string | number | undefined;
}): OptionContract | null {
  const right = input.right?.toUpperCase();
  const strike = Number(input.strike);
  if (
    input.conid === undefined ||
    !input.symbol ||
    !input.maturityDate ||
    (right !== "C" && right !== "P") ||
    !Number.isFinite(strike) ||
    strike <= 0
  ) {
    return null;
  }
  const expiry = calendarDate(input.maturityDate);
  return {
    conid: input.conid,
    underlying: input.symbol.trim().toUpperCase(),
    expiry,
    strike,
    right,
    symbol: formatOsiOptionSymbol({
      underlying: input.symbol,
      expiry,
      strike,
      right,
    }),
  };
}
