import type {
  DerivativeAssetClass,
  DerivativeContract,
  DerivativeDataAvailability,
  OptionRight,
} from "../types.js";
import type { IbkrSecdefInfo } from "./ibkrApiTypes.js";

function calendarDate(raw: string): string | null {
  const digits = raw.replace(/-/g, "");
  if (!/^\d{8}$/.test(digits)) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function optionRight(raw: string | undefined): OptionRight | null {
  const right = raw?.toUpperCase();
  return right === "C" || right === "P" ? right : null;
}

/** Normalize IBKR field 6509 without treating missing subscriptions as live data. */
export function normalizeDerivativeDataAvailability(
  raw: string | number | undefined
): DerivativeDataAvailability {
  const timeline = String(raw ?? "")
    .charAt(0)
    .toUpperCase();
  if (timeline === "R") return "live";
  if (timeline === "D") return "delayed";
  if (timeline === "Z") return "frozen";
  if (timeline === "Y") return "frozen-delayed";
  return "unavailable";
}

export function normalizeDerivativeContract(
  raw: IbkrSecdefInfo,
  expectedAssetClass: DerivativeAssetClass,
  fallbackUnderlying: string
): DerivativeContract | null {
  const assetClass = raw.secType?.toUpperCase();
  const expiration = raw.maturityDate ? calendarDate(raw.maturityDate) : null;
  const right = optionRight(raw.right);
  const strike = Number(raw.strike);
  const multiplier = Number(raw.multiplier);
  const exchange = raw.exchange?.trim().toUpperCase();
  const tradingClass = raw.tradingClass?.trim().toUpperCase();
  if (
    raw.conid === undefined ||
    assetClass !== expectedAssetClass ||
    !expiration ||
    !right ||
    !Number.isFinite(strike) ||
    strike <= 0 ||
    !Number.isFinite(multiplier) ||
    multiplier <= 0 ||
    !exchange ||
    !tradingClass
  ) {
    return null;
  }

  return {
    conid: raw.conid,
    assetClass: expectedAssetClass,
    underlying: (raw.symbol ?? fallbackUnderlying).trim().toUpperCase(),
    expiration,
    strike,
    right,
    tradingClass,
    exchange,
    multiplier,
    ...(raw.settlement ? { settlement: raw.settlement } : {}),
    ...(raw.exerciseStyle ? { exerciseStyle: raw.exerciseStyle } : {}),
  };
}
