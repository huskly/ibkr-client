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
  OptionContract,
  OptionMarketQuote,
  OptionQuoteRequest,
  OptionRight,
  PriceHistoryBar,
  PriceHistoryRequest,
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
  IbkrSecdefByConidResponse,
  IbkrSecdefInfo,
  IbkrSecdefSearchResult,
  IbkrSecdefStrikesResponse,
  IbkrStockContract,
  IbkrStockListing,
  IbkrStocksResponse,
} from "./ibkrApiTypes.js";
import { normalizeOptionContract, parseOsiOptionSymbol } from "./optionContract.js";

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
const OPTION_QUOTE_FIELDS = [
  "84", // Bid
  "86", // Ask
  "7308", // Delta
].join(",");
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
const OPTION_DISCOVERY_MONTH_CONCURRENCY = 1;
const OPTION_SECDEF_INFO_BATCH_SIZE = 8;
const OPTION_MARKETDATA_BATCH_SIZE = 100;
const READ_ONLY_REQUEST_MAX_RETRIES = 3;
const REQUEST_RETRY_BASE_DELAY_MS = 250;
const REQUEST_RETRY_MAX_DELAY_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseRetryAfter(raw: unknown): number | undefined {
  const asString = typeof raw === "string" ? raw.trim() : undefined;
  if (!asString) return undefined;

  const numeric = Number(asString);
  if (Number.isFinite(numeric) && numeric > 0) return Math.ceil(numeric * 1000);

  const date = Date.parse(asString);
  if (!Number.isNaN(date)) {
    const ms = Math.max(0, date - Date.now());
    if (ms > 0) return ms;
  }

  return undefined;
}

function isHeadersLike(input: unknown): input is { get(name: string): string | null } {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { get?: unknown }).get === "function"
  );
}

function headerToString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return headerToString(value[0]);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return String(value);
  }
  return undefined;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function monthCode(calendarDate: string): string {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-\d{2}$/.exec(calendarDate);
  const year = Number(match?.groups?.["year"]);
  const month = Number(match?.groups?.["month"]);
  if (!match || month < 1 || month > 12) throw new Error(`Invalid calendar date: ${calendarDate}`);
  const monthName = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ][month - 1];
  return `${String(monthName)}${String(year).slice(2)}`;
}

function monthCodes(fromDate: string, toDate: string): string[] {
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    throw new Error(`Invalid option expiry range: ${fromDate}..${toDate}`);
  }
  const result: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    result.push(monthCode(cursor.toISOString().slice(0, 10)));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return result;
}

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
  private readonly optionDiscovery = new Map<string, Promise<OptionContract[]>>();

  constructor(config: IbkrOauth1Config) {
    this.raw = new RawIbkrClientCtor(config);
  }

  /** Obtain the live session token (idempotent — safe to await repeatedly). */
  init(): Promise<void> {
    this.initPromise ??= (async () => {
      await this.raw.init();
      // IBKR is slow right after init; give the session a moment to settle.
      await this.wait(1000);
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
    await this.wait(2000);
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
      ...(p.multiplier === undefined ? {} : { multiplier: p.multiplier }),
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
    await this.wait(2000);
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
    const osi = parseOsiOptionSymbol(symbol);
    if (osi) {
      const option = await this.resolveOptionContract({
        symbol: osi.underlying,
        expiry: osi.expiry,
        strike: osi.strike,
        right: osi.right,
      });
      return option
        ? {
            requestedSymbol: symbol,
            symbol: option.symbol,
            conid: option.conid,
          }
        : undefined;
    }
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

  /** Return normalized daily price history without consulting a vendor-owned clock. */
  async getPriceHistory(input: PriceHistoryRequest): Promise<PriceHistoryBar[]> {
    const contract = await this.resolveQuoteContract(input.symbol);
    if (!contract) throw new Error(`IBKR could not resolve market-data contract: ${input.symbol}`);
    const days = this.historyDays(input);
    const history = await this.fetchQuoteHistory(contract.conid, `${String(days)}d`, false);
    const volumeFactor = history?.volumeFactor ?? 1;
    return (history?.data ?? []).map((bar) => {
      if (
        bar.t === undefined ||
        bar.o === undefined ||
        bar.h === undefined ||
        bar.l === undefined ||
        bar.c === undefined ||
        bar.v === undefined
      ) {
        throw new Error(`IBKR returned an incomplete history bar for ${input.symbol}`);
      }
      return {
        datetime: bar.t,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v * volumeFactor,
      };
    });
  }

  /** Discover every listed weekly/monthly expiry in the requested calendar range. */
  async getOptionExpiries(
    symbol: string,
    right: OptionRight,
    fromDate: string,
    toDate: string
  ): Promise<string[]> {
    const normalized = symbol.trim().toUpperCase();
    const months = monthCodes(fromDate, toDate);
    const contracts: OptionContract[] = [];
    for (let index = 0; index < months.length; index += OPTION_DISCOVERY_MONTH_CONCURRENCY) {
      const batch = months.slice(index, index + OPTION_DISCOVERY_MONTH_CONCURRENCY);
      const batchContracts = (
        await Promise.all(batch.map((month) => this.discoverOptions(normalized, month)))
      ).flat();
      contracts.push(...batchContracts);
    }
    return [
      ...new Set(
        contracts
          .filter(
            (contract) =>
              contract.right === right && contract.expiry >= fromDate && contract.expiry <= toDate
          )
          .map((contract) => contract.expiry)
      ),
    ].sort();
  }

  /** Build one exact-expiry chain with canonical OSI symbols and required pricing/greeks. */
  async getOptionChain(symbol: string, expiry: string): Promise<OptionMarketQuote[]> {
    const contracts = (await this.discoverOptions(symbol, monthCode(expiry))).filter(
      (contract) => contract.expiry === expiry
    );
    if (!contracts.length) {
      throw new Error(`IBKR returned no option contracts for ${symbol} ${expiry}`);
    }
    const quoted = await this.fetchOptionQuotes(contracts, { allowIncomplete: true });
    if (!quoted.length) {
      throw new Error(`IBKR returned no usable option quotes for ${symbol} ${expiry}`);
    }
    return quoted;
  }

  /** Fetch one exact option quote; null means the contract is not listed. */
  async getOptionQuote(input: OptionQuoteRequest): Promise<OptionMarketQuote | null> {
    const contract = await this.resolveOptionContract(input);
    if (!contract) return null;
    return (await this.fetchOptionQuotes([contract]))[0] ?? null;
  }

  /** Resolve a conid back into the canonical OSI-bearing option contract. */
  async getOptionContract(conid: number): Promise<OptionContract | null> {
    const response = await this.req<IbkrSecdefByConidResponse>({
      path: "trsrv/secdef",
      params: { conids: String(conid) },
    });
    const raw = response[String(conid)];
    if (!raw) return null;
    return normalizeOptionContract({
      conid: raw.conid ?? conid,
      symbol: raw.symbol,
      maturityDate: raw.expiry,
      right: raw.putOrCall,
      strike: raw.strike,
    });
  }

  private async resolveOptionContract(input: OptionQuoteRequest): Promise<OptionContract | null> {
    const contracts = await this.discoverOptions(input.symbol, monthCode(input.expiry));
    return (
      contracts.find(
        (contract) =>
          contract.expiry === input.expiry &&
          contract.right === input.right &&
          contract.strike === input.strike
      ) ?? null
    );
  }

  private discoverOptions(symbol: string, month: string): Promise<OptionContract[]> {
    const normalized = symbol.trim().toUpperCase();
    const key = `${normalized}:${month}`;
    let pending = this.optionDiscovery.get(key);
    if (!pending) {
      pending = this.loadOptionContracts(normalized, month);
      this.optionDiscovery.set(key, pending);
    }
    return pending;
  }

  private async loadOptionContracts(symbol: string, month: string): Promise<OptionContract[]> {
    // This search is load-bearing: IBKR silently returns empty strikes unless the current
    // session has first searched the underlying.
    const search = await this.req<IbkrSecdefSearchResult[]>({
      path: "iserver/secdef/search",
      params: { symbol },
    });
    const underlying = search.find(
      (candidate) =>
        candidate.conid !== undefined &&
        candidate.sections?.some((section) => section.secType === "OPT")
    );
    if (underlying?.conid === undefined) {
      throw new Error(`IBKR did not identify ${symbol} as an optionable underlying`);
    }

    const strikes = await this.req<IbkrSecdefStrikesResponse>({
      path: "iserver/secdef/strikes",
      params: { conid: String(underlying.conid), sectype: "OPT", month },
    });
    const requests = [
      ...(strikes.call ?? []).map((strike) => ({ strike, right: "C" as const })),
      ...(strikes.put ?? []).map((strike) => ({ strike, right: "P" as const })),
    ];
    if (!requests.length) {
      throw new Error(
        `IBKR returned empty option strikes for ${symbol} ${month} after secdef/search priming`
      );
    }

    const contracts: OptionContract[] = [];
    for (const batch of chunks(requests, OPTION_SECDEF_INFO_BATCH_SIZE)) {
      const responses = await Promise.all(
        batch.map(({ strike, right }) =>
          this.req<IbkrSecdefInfo[]>({
            path: "iserver/secdef/info",
            params: {
              conid: String(underlying.conid),
              sectype: "OPT",
              month,
              strike,
              right,
            },
          })
        )
      );
      for (const raw of responses.flat()) {
        const contract = normalizeOptionContract({
          conid: raw.conid,
          symbol: raw.symbol ?? underlying.symbol ?? symbol,
          maturityDate: raw.maturityDate,
          right: raw.right,
          strike: raw.strike,
        });
        if (contract) contracts.push(contract);
      }
    }
    const unique = [...new Map(contracts.map((contract) => [contract.conid, contract])).values()];
    if (!unique.length) {
      throw new Error(`IBKR returned no usable option definitions for ${symbol} ${month}`);
    }
    return unique;
  }

  private async fetchOptionQuotes(
    contracts: readonly OptionContract[],
    options: { allowIncomplete?: boolean } = {}
  ): Promise<OptionMarketQuote[]> {
    const { allowIncomplete = false } = options;
    const result: OptionMarketQuote[] = [];
    const skipped: string[] = [];
    for (const batch of chunks(contracts, OPTION_MARKETDATA_BATCH_SIZE)) {
      const params = {
        conids: batch.map((contract) => contract.conid).join(","),
        fields: OPTION_QUOTE_FIELDS,
      };
      await this.req<unknown>({ path: "iserver/marketdata/snapshot", params });
      await this.wait(2000);
      const snapshots = await this.req<IbkrMarketDataSnapshot[]>({
        path: "iserver/marketdata/snapshot",
        params,
      });
      const byConid = new Map(
        snapshots
          .filter(
            (snapshot): snapshot is IbkrMarketDataSnapshot & { conid: number } =>
              snapshot.conid !== undefined
          )
          .map((snapshot) => [snapshot.conid, snapshot])
      );
      for (const contract of batch) {
        const snapshot = byConid.get(contract.conid);
        const bid = snapshot ? this.snapshotNumber(snapshot, "84") : undefined;
        const ask = snapshot ? this.snapshotNumber(snapshot, "86") : undefined;
        const delta = snapshot ? this.snapshotNumber(snapshot, "7308") : undefined;
        if (bid === undefined || ask === undefined || delta === undefined) {
          if (allowIncomplete) {
            skipped.push(contract.symbol);
            continue;
          }
          throw new Error(
            `IBKR returned incomplete option market data for ${contract.symbol} (bid/ask/delta required)`
          );
        }
        result.push({ ...contract, bid, ask, mid: (bid + ask) / 2, delta });
      }
    }
    if (allowIncomplete && skipped.length && skipped.length === contracts.length) {
      const symbol = contracts[0]?.underlying ?? "unknown";
      const expiry = contracts[0]?.expiry ?? "unknown";
      throw new Error(
        `IBKR returned unusable option market data for ${symbol} ${expiry} (all ${String(
          skipped.length
        )} contracts)`
      );
    }
    return result;
  }

  private historyDays(input: PriceHistoryRequest): number {
    if (input.days !== undefined) {
      if (!Number.isFinite(input.days) || input.days <= 0) {
        throw new Error(`History days must be positive: ${String(input.days)}`);
      }
      return Math.ceil(input.days);
    }
    if (input.startDate === undefined || input.endDate === undefined) {
      throw new Error("Price history requires days or both startDate and endDate");
    }
    const duration = input.endDate - input.startDate;
    if (duration < 0) throw new Error("Price history endDate must not precede startDate");
    return Math.max(1, Math.ceil(duration / 86_400_000) + 1);
  }

  private async fetchQuoteHistory(
    conid: number,
    period = "5d",
    suppressErrors = true
  ): Promise<IbkrMarketDataHistoryResponse | undefined> {
    try {
      return await this.req<IbkrMarketDataHistoryResponse>({
        path: "iserver/marketdata/history",
        params: {
          conid: String(conid),
          period,
          bar: "1d",
          outsideRth: true,
        },
      });
    } catch (error) {
      if (!suppressErrors) throw error;
      return undefined;
    }
  }

  /** Overridable in request-level tests so snapshot warm-up does not sleep. */
  protected wait(ms: number): Promise<void> {
    return sleep(ms);
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
    if (!history?.data?.length) return undefined;
    return history.data[history.data.length - 1];
  }

  private previousHistoryBar(
    history: IbkrMarketDataHistoryResponse | undefined
  ): IbkrMarketDataHistoryBar | undefined {
    if (!history?.data || history.data.length < 2) return undefined;
    return history.data[history.data.length - 2];
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
  protected async sendRequest<T>(input: {
    path: string;
    method?: string;
    params?: Record<string, string | number | boolean | null | undefined>;
    data?: object;
  }): Promise<T> {
    return (await this.raw.request(input)) as T;
  }

  protected async req<T>(input: {
    path: string;
    method?: string;
    params?: Record<string, string | number | boolean | null | undefined>;
    data?: object;
  }): Promise<T> {
    let retries = 0;
    for (;;) {
      try {
        return await this.sendRequest<T>(input);
      } catch (error) {
        const status = this.httpStatusFromError(error);
        if (status !== 429 || retries >= READ_ONLY_REQUEST_MAX_RETRIES) {
          throw error;
        }
        const retryAfter = this.retryAfterFromError(error);
        const delayMs = this.computeBackoffDelayMs(retries, retryAfter);
        retries += 1;
        await this.wait(delayMs);
      }
    }
  }

  private httpStatusFromError(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const response = (error as { response?: unknown }).response;
    const directStatus = this.numberFromUnknown((error as { status?: unknown }).status);
    if (directStatus !== undefined) return directStatus;
    const directStatusCode = this.numberFromUnknown((error as { statusCode?: unknown }).statusCode);
    if (directStatusCode !== undefined) return directStatusCode;
    if (typeof response === "object" && response !== null) {
      return this.numberFromUnknown(
        (response as { status?: unknown }).status ??
          (response as { statusCode?: unknown }).statusCode
      );
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      const match = /\b429\b/.exec(message);
      if (match) return 429;
    }
    return undefined;
  }

  private retryAfterFromError(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const response = (error as { response?: unknown }).response;
    const responseHeaders =
      response && typeof response === "object" && "headers" in response
        ? response.headers
        : undefined;
    const directHeaders = (error as { headers?: unknown }).headers;
    const retryAfterRaw =
      this.headerValue(responseHeaders, "Retry-After") ??
      this.headerValue(directHeaders, "Retry-After");
    return parseRetryAfter(retryAfterRaw);
  }

  private computeBackoffDelayMs(retry: number, retryAfterMs: number | undefined): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, REQUEST_RETRY_MAX_DELAY_MS);
    return Math.min(REQUEST_RETRY_BASE_DELAY_MS * 2 ** retry, REQUEST_RETRY_MAX_DELAY_MS);
  }

  private numberFromUnknown(value: unknown): number | undefined {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private headerValue(headers: unknown, headerName: string): string | undefined {
    const canonical = headerName.toLowerCase();
    if (headers === undefined || headers === null) return undefined;

    if (isHeadersLike(headers)) {
      const direct = headers.get(canonical) ?? headers.get(headerName);
      return direct ?? undefined;
    }

    if (typeof headers === "object") {
      const bucket = headers as Record<string, unknown>;
      const direct = headerToString(bucket[headerName]) ?? headerToString(bucket[canonical]);
      if (direct !== undefined) return direct;

      for (const [key, value] of Object.entries(bucket)) {
        if (key.toLowerCase() !== canonical) continue;
        const candidate = headerToString(value);
        if (candidate !== undefined) return candidate;
      }
    }

    return undefined;
  }
}
