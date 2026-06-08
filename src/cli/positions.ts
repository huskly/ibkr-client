import chalk from "chalk";
import { apiClient } from "./shared.js";
import { fmtMoney, fmtPct, pad, pnlColor } from "../format.js";
import type { BrokerName, BrokerPosition } from "../types.js";

interface PositionsOptions {
  type?: string;
  csv?: boolean;
}

const HEADERS = [
  "Symbol",
  "Type",
  "Long",
  "Short",
  "Avg Price",
  "Cur Price",
  "Mkt Value",
  "Day P/L",
  "P/L Open",
  "P/L %",
] as const;

/** Columns 0 (Symbol) and 1 (Type) are left-aligned; the rest right-aligned. */
const LEFT_ALIGNED = new Set([0, 1]);

/** Open P/L as a fraction of cost basis (marketValue net of open P/L). */
function plPercent(pos: BrokerPosition): number | null {
  const costBasis = pos.marketValue - pos.openProfitLoss;
  return costBasis ? (pos.openProfitLoss / costBasis) * 100 : null;
}

/** Escape a value for CSV output. */
function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Show account positions as a table (or CSV).
 * Ports render_positions() from main.py.
 */
export async function handlePositions(
  broker: BrokerName,
  symbol: string | undefined,
  options: PositionsOptions
): Promise<void> {
  const api = await apiClient(broker);
  let positions = await api.getPositions(symbol);

  if (options.type) {
    const upper = options.type.toUpperCase();
    positions = positions.filter((p) => p.assetType.toUpperCase() === upper);
  }
  positions = positions.sort((a, b) => a.symbol.localeCompare(b.symbol));

  if (options.csv) {
    renderCsv(positions);
    return;
  }
  renderTable(symbol, options.type, positions);
}

function renderCsv(positions: BrokerPosition[]): void {
  if (positions.length === 0) return;
  console.log(HEADERS.join(","));
  for (const p of positions) {
    const pct = plPercent(p);
    console.log(
      [
        escapeCsv(p.symbol),
        escapeCsv(p.assetType),
        p.longQuantity || "",
        p.shortQuantity || "",
        p.averagePrice.toFixed(2),
        p.marketPrice.toFixed(2),
        p.marketValue.toFixed(2),
        p.currentDayProfitLoss.toFixed(2),
        p.openProfitLoss.toFixed(2),
        pct === null ? "" : pct.toFixed(2),
      ].join(",")
    );
  }
}

function renderTable(
  symbol: string | undefined,
  type: string | undefined,
  positions: BrokerPosition[]
): void {
  const filters = [symbol?.toUpperCase(), type?.toUpperCase()].filter(Boolean);
  const filterText = filters.length ? `: ${filters.join(", ")}` : "";
  console.log(chalk.bold(`\nAccount Positions${filterText}\n`));

  if (positions.length === 0) {
    console.log(chalk.yellow("  (no open positions)"));
    return;
  }

  // Each cell is [text, colorFn]; colorize after width is measured on raw text.
  const rows = positions.map((p): [string, (s: string) => string][] => {
    const pct = plPercent(p);
    return [
      [p.symbol, chalk.cyan],
      [p.assetType, chalk.white],
      [p.longQuantity > 0 ? String(p.longQuantity) : "-", chalk.green],
      [p.shortQuantity > 0 ? String(p.shortQuantity) : "-", chalk.red],
      [fmtMoney(p.averagePrice), chalk.white],
      [fmtMoney(p.marketPrice), chalk.white],
      [fmtMoney(p.marketValue), pnlColor(p.marketValue)],
      [fmtMoney(p.currentDayProfitLoss, true), pnlColor(p.currentDayProfitLoss)],
      [fmtMoney(p.openProfitLoss, true), pnlColor(p.openProfitLoss)],
      [fmtPct(pct), pnlColor(pct)],
    ];
  });

  const widths = HEADERS.map((h) => h.length);
  for (const row of rows) {
    row.forEach(([text], i) => {
      widths[i] = Math.max(widths[i] ?? 0, text.length);
    });
  }

  const align = (i: number): "left" | "right" => (LEFT_ALIGNED.has(i) ? "left" : "right");
  const gap = "  ";
  const headerLine = HEADERS.map((h, i) => chalk.dim(pad(h, widths[i] ?? 0, align(i)))).join(gap);
  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + gap.length * (widths.length - 1);

  console.log(headerLine);
  console.log(chalk.dim("-".repeat(totalWidth)));
  for (const row of rows) {
    console.log(
      row.map(([text, color], i) => color(pad(text, widths[i] ?? 0, align(i)))).join(gap)
    );
  }
  console.log();
}
