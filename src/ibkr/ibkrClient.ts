import { createRequire } from "node:module";
import type { IbkrClient as RawIbkrClient } from "ibkr-client";
import type { IbkrOauth1Config } from "./oauthConfig.js";
import type {
  AccountBalances,
  AuthStatus,
  BrokerClient,
  BrokerInstrument,
  BrokerPosition,
  BrokerQuote,
} from "../types.js";
import { ASSET_CLASS_LABELS, toNumber } from "../helpers.js";
import type {
  IbkrAuthStatus,
  IbkrMarketDataHistoryBar,
  IbkrMarketDataHistoryResponse,
  IbkrMarketDataSnapshot,
  IbkrPortfolioAccount,
  IbkrPortfolioSummary,
  IbkrPosition,
  IbkrStockContract,
  IbkrStockListing,
  IbkrStocksResponse,
} from "./ibkrApiTypes.js";

// `ibkr-client`'s published ESM build is broken: its `import` condition points
// at files that use extensionless relative imports, which Node's strict ESM
// resolver rejects. Its CJS build is fine, so we deliberately load that via
// createRequire. This is the one intentional createRequire in the package —
// everything else imports natively as ESM. Revisit if upstream fixes their ESM.
const require = createRequire(import.meta.url);
const { IbkrClient: RawIbkrClientCtor } = require("ibkr-client") as {
  IbkrClient: new (config: IbkrOauth1Config) => RawIbkrClient;
};

/** A resolved quote target: the requested symbol mapped to an IBKR conid. */
interface QuoteContract {
  requestedSymbol: string;
  symbol: string;
  conid: number;
  description?: string;
  exchange?: string;
}

/** Live market-data snapshot field 78 = position's P&L for the current day. */
const DAY_PNL_FIELD = "78";
const QUOTE_FIELDS = [
  "31", // Last
  "55", // Symbol
  "58", // Text
  "70", // High
  "71", // Low
  "82", // Change
  "83", // Change %
  "84", // Bid
  "86", // Ask
  "87", // Formatted volume
  "6004", // Exchange
  "6509", // Market data availability
  "7762", // Unformatted volume
].join(",");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Typed IBKR Web API client implementing the broker-neutral {@link BrokerClient}.
 * Wraps the `ibkr-client` npm package, which performs the OAuth 1.0a
 * live-session-token handshake. Ports the data access from the Python PoC
 * (main.py): account summary, positions paging, and day-P/L snapshots.
 */
export class IbkrClient implements BrokerClient {
  private readonly raw: RawIbkrClient;
  private initPromise?: Promise<void>;
  private accountIdPromise?: Promise<string>;

  constructor(config: IbkrOauth1Config) {
    this.raw = new RawIbkrClientCtor(config);
  }

  /** Obtain the live session token (idempotent — safe to await repeatedly). */
  init(): Promise<void> {
    this.initPromise ??= (async () => {
      await this.raw.init();
      // IBKR is slow right after init; give the session a moment to settle.
      await sleep(1000);
    })();
    return this.initPromise;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const status = await this.req<IbkrAuthStatus>({
      path: "iserver/auth/status",
      method: "POST",
    });
    return {
      authenticated: status.authenticated ?? false,
      competing: status.competing ?? false,
    };
  }

  async getAccountId(): Promise<string> {
    this.accountIdPromise ??= (async () => {
      const override = process.env["IBKR_ACCOUNT_ID"];
      if (override) return override;
      const accounts = await this.req<IbkrPortfolioAccount[]>({ path: "portfolio/accounts" });
      const first = accounts[0];
      if (!first) throw new Error("No portfolio accounts returned by IBKR");
      return first.accountId;
    })();
    return this.accountIdPromise;
  }

  async getAccountBalances(): Promise<AccountBalances> {
    const accountId = await this.getAccountId();
    const summary = await this.req<IbkrPortfolioSummary>({
      path: `portfolio/${accountId}/summary`,
    });
    const amount = (key: string): number => toNumber(summary[key]?.amount);
    return {
      netLiquidation: amount("netliquidation"),
      availableFunds: amount("availablefunds"),
      buyingPower: amount("buyingpower"),
      cashBalance: amount("totalcashvalue"),
    };
  }

  async getPositions(symbol?: string): Promise<BrokerPosition[]> {
    const accountId = await this.getAccountId();
    const rows = await this.fetchAllPositions(accountId);
    const dayPnl = await this.fetchDayPnl(rows.map((p) => String(p.conid)).filter(Boolean));

    let positions = rows.map((p) => this.normalizePosition(p, dayPnl));
    if (symbol) {
      const upper = symbol.toUpperCase();
      positions = positions.filter((p) => p.symbol.toUpperCase().includes(upper));
    }
    return positions;
  }

  /** Page through the positions endpoint until it stops returning rows. */
  private async fetchAllPositions(accountId: string): Promise<IbkrPosition[]> {
    const out: IbkrPosition[] = [];
    let page = 0;
    for (;;) {
      const rows = await this.req<IbkrPosition[]>({
        path: `portfolio/${accountId}/positions/${String(page)}`,
      });
      if (!rows.length) break;
      out.push(...rows);
      page += 1;
    }
    return out;
  }

  /** Return { conid: day P&L }. Snapshots need a warm-up call before data lands. */
  private async fetchDayPnl(conids: string[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (!conids.length) return result;

    const params = { conids: conids.join(","), fields: DAY_PNL_FIELD };
    await this.req<unknown>({ path: "iserver/marketdata/snapshot", params }); // warm up
    await sleep(2000);
    const snapshot = await this.req<IbkrMarketDataSnapshot[]>({
      path: "iserver/marketdata/snapshot",
      params,
    });

    for (const row of snapshot) {
      const raw = row[DAY_PNL_FIELD];
      if (raw !== undefined && row.conid !== undefined) {
        result.set(row.conid, toNumber(raw));
      }
    }
    return result;
  }

  private normalizePosition(p: IbkrPosition, dayPnl: Map<number, number>): BrokerPosition {
    const qty = p.position ?? 0;
    const assetClass = p.assetClass ?? "";
    return {
      symbol: p.contractDesc ?? String(p.conid ?? "-"),
      assetType: ASSET_CLASS_LABELS[assetClass] ?? (assetClass || "-"),
      longQuantity: qty > 0 ? qty : 0,
      shortQuantity: qty < 0 ? Math.abs(qty) : 0,
      averagePrice: toNumber(p.avgPrice),
      marketPrice: toNumber(p.mktPrice),
      marketValue: toNumber(p.mktValue),
      currentDayProfitLoss: p.conid !== undefined ? (dayPnl.get(p.conid) ?? 0) : 0,
      openProfitLoss: toNumber(p.unrealizedPnl),
    };
  }

  async getQuotes(symbols: string[]): Promise<Record<string, BrokerQuote>> {
    const contracts = await Promise.all(symbols.map((symbol) => this.resolveQuoteContract(symbol)));
    const resolvedContracts = contracts.filter(
      (contract): contract is QuoteContract => contract !== undefined
    );
    if (!resolvedContracts.length) return {};

    const conids = resolvedContracts.map((contract) => contract.conid).join(",");
    const params = { conids, fields: QUOTE_FIELDS };
    await this.req<unknown>({ path: "iserver/marketdata/snapshot", params }); // warm up
    await sleep(2000);
    const snapshots = await this.req<IbkrMarketDataSnapshot[]>({
      path: "iserver/marketdata/snapshot",
      params,
    });

    const snapshotByConid = new Map(
      snapshots
        .filter(
          (snapshot): snapshot is IbkrMarketDataSnapshot & { conid: number } =>
            snapshot.conid !== undefined
        )
        .map((snapshot) => [snapshot.conid, snapshot])
    );
    const histories = await Promise.all(
      resolvedContracts.map((contract) => this.fetchQuoteHistory(contract.conid))
    );
    const quotes: Record<string, BrokerQuote> = {};

    for (const [index, contract] of resolvedContracts.entries()) {
      const snapshot = snapshotByConid.get(contract.conid);
      if (snapshot === undefined) continue;
      const history = histories[index];
      const quote = this.normalizeQuote(contract, snapshot, history);
      quotes[contract.requestedSymbol] = quote;
      quotes[contract.symbol] = quote;
    }

    return quotes;
  }

  /** Resolve equity/ETF symbols to IBKR contracts via `trsrv/stocks`. */
  private async searchInstruments(symbol: string): Promise<BrokerInstrument[]> {
    const query = symbol.trim().toUpperCase();
    if (!query) return [];

    const response = await this.req<IbkrStocksResponse>({
      path: "trsrv/stocks",
      params: { symbols: query },
    });

    return (response[query] ?? []).flatMap((listing) => this.normalizeStockListing(query, listing));
  }

  private normalizeStockListing(symbol: string, listing: IbkrStockListing): BrokerInstrument[] {
    const assetType = listing.assetClass === "STK" ? "EQUITY" : listing.assetClass;
    const contracts = listing.contracts ?? [];
    if (!contracts.length) {
      return [
        {
          symbol,
          ...(listing.name !== undefined ? { description: listing.name } : {}),
          ...(assetType !== undefined ? { assetType } : {}),
        },
      ];
    }

    return contracts.map((contract) => this.normalizeStockContract(symbol, listing, contract));
  }

  private normalizeStockContract(
    symbol: string,
    listing: IbkrStockListing,
    contract: IbkrStockContract
  ): BrokerInstrument {
    const assetType = listing.assetClass === "STK" ? "EQUITY" : listing.assetClass;
    return {
      symbol,
      ...(listing.name !== undefined ? { description: listing.name } : {}),
      ...(contract.exchange !== undefined ? { exchange: contract.exchange } : {}),
      ...(assetType !== undefined ? { assetType } : {}),
      ...(contract.conid !== undefined ? { brokerId: String(contract.conid) } : {}),
    };
  }

  private async resolveQuoteContract(symbol: string): Promise<QuoteContract | undefined> {
    const instruments = await this.searchInstruments(symbol);
    const instrument = instruments.find((item) => item.brokerId !== undefined);
    if (instrument?.brokerId === undefined) return undefined;
    const conid = parseInt(instrument.brokerId, 10);
    if (Number.isNaN(conid)) return undefined;

    return {
      requestedSymbol: symbol,
      symbol: instrument.symbol ?? symbol.toUpperCase(),
      conid,
      ...(instrument.description !== undefined ? { description: instrument.description } : {}),
      ...(instrument.exchange !== undefined ? { exchange: instrument.exchange } : {}),
    };
  }

  private async fetchQuoteHistory(
    conid: number
  ): Promise<IbkrMarketDataHistoryResponse | undefined> {
    try {
      return await this.req<IbkrMarketDataHistoryResponse>({
        path: "iserver/marketdata/history",
        params: {
          conid: String(conid),
          period: "5d",
          bar: "1d",
          outsideRth: true,
        },
      });
    } catch {
      return undefined;
    }
  }

  private normalizeQuote(
    contract: QuoteContract,
    snapshot: IbkrMarketDataSnapshot,
    history: IbkrMarketDataHistoryResponse | undefined
  ): BrokerQuote {
    const symbol = this.snapshotString(snapshot, "55") ?? contract.symbol;
    const description =
      this.snapshotString(snapshot, "58") ?? history?.text ?? contract.description;
    const exchange = this.snapshotString(snapshot, "6004") ?? contract.exchange;
    const latestBar = this.latestHistoryBar(history);
    const previousBar = this.previousHistoryBar(history);
    const snapshotLastPrice = this.snapshotNumber(snapshot, "31");
    const lastPrice = this.snapshotHasPrefix(snapshot, "31", "C")
      ? (latestBar?.c ?? snapshotLastPrice)
      : (snapshotLastPrice ?? latestBar?.c);
    const bidPrice = this.snapshotNumber(snapshot, "84");
    const askPrice = this.snapshotNumber(snapshot, "86");
    const closePrice = previousBar?.c;
    const highPrice = this.snapshotNumber(snapshot, "70") ?? latestBar?.h;
    const lowPrice = this.snapshotNumber(snapshot, "71") ?? latestBar?.l;
    const openPrice = latestBar?.o;
    const netChange =
      this.snapshotNumber(snapshot, "82") ??
      (lastPrice !== undefined && closePrice !== undefined ? lastPrice - closePrice : undefined);
    const netPercentChange =
      this.snapshotPercent(snapshot, "83") ??
      (netChange !== undefined && closePrice !== undefined && closePrice !== 0
        ? (netChange / closePrice) * 100
        : undefined);
    const totalVolume = this.snapshotVolume(snapshot) ?? this.historyVolume(history, latestBar);

    return {
      symbol,
      reference: {
        ...(description !== undefined ? { description } : {}),
        ...(exchange !== undefined ? { exchange, exchangeName: exchange } : {}),
      },
      quote: {
        ...(lastPrice !== undefined ? { lastPrice } : {}),
        ...(bidPrice !== undefined ? { bidPrice } : {}),
        ...(askPrice !== undefined ? { askPrice } : {}),
        ...(closePrice !== undefined ? { closePrice } : {}),
        ...(highPrice !== undefined ? { highPrice } : {}),
        ...(lowPrice !== undefined ? { lowPrice } : {}),
        ...(openPrice !== undefined ? { openPrice } : {}),
        ...(netChange !== undefined ? { netChange } : {}),
        ...(netPercentChange !== undefined ? { netPercentChange } : {}),
        ...(totalVolume !== undefined ? { totalVolume } : {}),
      },
    };
  }

  private latestHistoryBar(
    history: IbkrMarketDataHistoryResponse | undefined
  ): IbkrMarketDataHistoryBar | undefined {
    return history?.data?.at(-1);
  }

  private previousHistoryBar(
    history: IbkrMarketDataHistoryResponse | undefined
  ): IbkrMarketDataHistoryBar | undefined {
    return history?.data?.at(-2);
  }

  private historyVolume(
    history: IbkrMarketDataHistoryResponse | undefined,
    bar: IbkrMarketDataHistoryBar | undefined
  ): number | undefined {
    if (bar?.v === undefined) return undefined;
    return bar.v * (history?.volumeFactor ?? 1);
  }

  private snapshotString(snapshot: IbkrMarketDataSnapshot, field: string): string | undefined {
    const value = snapshot[field];
    if (value === undefined) return undefined;
    const stringValue = String(value).trim();
    return stringValue ? stringValue : undefined;
  }

  private snapshotNumber(snapshot: IbkrMarketDataSnapshot, field: string): number | undefined {
    const value = this.snapshotString(snapshot, field);
    if (value === undefined) return undefined;
    const cleaned = value.replace(/^[A-Z]\s*/i, "").replace(/,/g, "");
    const parsed = parseFloat(cleaned);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private snapshotHasPrefix(
    snapshot: IbkrMarketDataSnapshot,
    field: string,
    prefix: string
  ): boolean {
    return this.snapshotString(snapshot, field)?.toUpperCase().startsWith(prefix) ?? false;
  }

  private snapshotPercent(snapshot: IbkrMarketDataSnapshot, field: string): number | undefined {
    const value = this.snapshotString(snapshot, field);
    if (value === undefined) return undefined;
    const cleaned = value.replace(/[%+,]/g, "");
    const parsed = parseFloat(cleaned);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private snapshotVolume(snapshot: IbkrMarketDataSnapshot): number | undefined {
    const unformatted = this.snapshotNumber(snapshot, "7762");
    if (unformatted !== undefined) return unformatted;

    const value = this.snapshotString(snapshot, "87");
    if (value === undefined) return undefined;
    const match = /^(?<amount>[\d,.]+)\s*(?<suffix>[KMB])?$/i.exec(value);
    const amount = match?.groups?.["amount"];
    if (amount === undefined) return undefined;
    const parsed = parseFloat(amount.replace(/,/g, ""));
    if (Number.isNaN(parsed)) return undefined;

    const suffix = match?.groups?.["suffix"]?.toUpperCase();
    if (suffix === "B") return parsed * 1_000_000_000;
    if (suffix === "M") return parsed * 1_000_000;
    if (suffix === "K") return parsed * 1_000;
    return parsed;
  }

  /** Typed wrapper around the raw client's untyped `request()`. */
  private async req<T>(input: {
    path: string;
    method?: string;
    params?: Record<string, string | number | boolean | null | undefined>;
    data?: object;
  }): Promise<T> {
    return (await this.raw.request(input)) as T;
  }
}
