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

/** Coerce an unknown (string | number | null) into a number, defaulting to 0. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}
