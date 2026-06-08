import chalk from "chalk";

/**
 * Terminal formatting helpers, ported from main.py (fmt_money / fmt_pct /
 * P&L coloring), using chalk instead of raw ANSI codes.
 */

/** Format a dollar amount. `signed` forces a leading +/- (for P&L). */
export function fmtMoney(value: number | null | undefined, signed = false): string {
  if (value === null || value === undefined) return "-";
  const sign = value < 0 ? "-" : signed ? "+" : "";
  const abs = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}

/** Format a percentage with an explicit +/- sign. */
export function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const sign = value < 0 ? "-" : "+";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

/** Green for non-negative P&L, red for losses. */
export function pnlColor(value: number | null | undefined): (text: string) => string {
  return (value ?? 0) < 0 ? chalk.red : chalk.green;
}

/** Pad `text` into `width`, left- or right-aligned. */
export function pad(text: string, width: number, align: "left" | "right" = "left"): string {
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}
