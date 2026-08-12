/** Small shared utilities. */

/** Throw if a value is null/undefined, otherwise narrow it to non-nullable. */
export function ensure<T>(value: T | null | undefined, message?: string): T {
  if (value === null || value === undefined) {
    throw new Error(message ?? "Expected value to be non-null/non-undefined");
  }
  return value;
}

/**
 * IBKR asset-class codes -> human-readable type labels.
 * Ported from main.py's ASSET_CLASS_LABELS.
 */
export const ASSET_CLASS_LABELS: Record<string, string> = {
  STK: "EQUITY",
  OPT: "OPTION",
  FOP: "FUTURES OPTION",
  FUT: "FUTURE",
  FUND: "COLLECTIVE_INVESTMENT",
  BOND: "BOND",
  WAR: "WARRANT",
  CASH: "FOREX",
  CFD: "CFD",
};

/** Parse a provider number with optional comma thousands separators. */
function parseProviderNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (
    trimmed.includes(",") &&
    !/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed)
  ) {
    return null;
  }
  const result = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(result) ? result : null;
}

/** Coerce an unknown (string | number | null) into a number, defaulting to 0. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  return typeof value === "string" ? (parseProviderNumber(value) ?? 0) : 0;
}

/** Coerce an unknown provider amount into a finite number or unavailable null. */
export function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return typeof value === "string" ? parseProviderNumber(value) : null;
}
