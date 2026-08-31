import { createRequire } from "node:module";
import type { IbkrClient as RawIbkrClient } from "ibkr-client";
import type { IbkrOauth1Config } from "./oauthConfig.js";
import type {
  AccountBalances,
  ActiveDerivativeOrder,
  ActiveDerivativeOrderLeg,
  ActiveDerivativeOrderUncertainty,
  AuthStatus,
  IbkrSessionEvidence,
  IbkrJsonEvidence,
  IbkrSessionLifecycleClient,
  BrokerAccountOrders,
  BrokerClient,
  BrokerInstrument,
  BrokerInstrumentSearchProjection,
  BrokerOrder,
  BrokerOrderLeg,
  BrokerOrdersOptions,
  BrokerPosition,
  BrokerQuote,
  BrokerQuoteOptions,
  BrokerQuoteRequest,
  BrokerTransaction,
  BrokerTransactionHistory,
  BrokerErrorDetail,
  BrokerEnvironment,
  DerivativeAssetClass,
  DerivativeContract,
  DerivativeContractQuery,
  DerivativeComboExecutionRequest,
  DerivativeComboReconciliation,
  DerivativeComboReconciliationRequest,
  DerivativeComboPreviewRequest,
  DerivativeComboPreviewResult,
  DerivativeContingentChildOrderRequest,
  DerivativeContingentOrderEvidence,
  DerivativeContingentParentOrderRequest,
  DerivativeDiscoveryClient,
  DerivativeExecutionClient,
  DerivativeExecution,
  DerivativeExecutionQuery,
  DerivativeExecutionSide,
  DerivativeLegExecutionSummary,
  DerivativeMultiOrderResult,
  DerivativeOrderGraphMemberEvidence,
  DerivativeOrderGraphLookup,
  DerivativeOrderGraphNode,
  DerivativeOrderGraphRequest,
  DerivativeOrderGraphResult,
  DerivativeOrderGraphWarningContinuation,
  DerivativeOrderCancellationResult,
  DerivativeOrderCancellationEvidence,
  DerivativeOrderCancelRequest,
  DerivativeOrderLifecycle,
  DerivativeOrderLookup,
  DerivativeOrderStatus,
  DerivativeOrderSubmissionResult,
  DerivativeSingleOrderRequest,
  DerivativeSubmittedOrder,
  DerivativePreviewClient,
  DerivativeExpiry,
  DerivativeExpiryQuery,
  DerivativeQuote,
  DerivativeReferenceQuote,
  OptionChainSnapshot,
  OptionChainSnapshotDiagnostics,
  OptionChainSnapshotField,
  OptionChainSnapshotQuote,
  OptionContract,
  OptionDefinitionCache,
  OptionDefinitionCacheEntry,
  OptionDefinitionCacheKey,
  OptionDiscoveryTelemetry,
  OptionMarketQuote,
  OptionStrikeRange,
  OptionQuoteRequest,
  OptionRight,
  OrderWarning,
  PriceHistoryBar,
  PriceHistoryContract,
  PriceHistoryContractCandidate,
  PriceHistoryRequest,
  PriceHistorySecurityType,
  PriceHistoryResult,
  PriceHistoryTelemetry,
  TradingDiagnostics,
} from "../types.js";
import { ASSET_CLASS_LABELS, toNullableNumber, toNumber } from "../helpers.js";
import type {
  IbkrContractInfo,
  IbkrLiveOrder,
  IbkrLiveOrdersResponse,
  IbkrOrderSubmissionResponse,
  IbkrMarketDataHistoryBar,
  IbkrMarketDataHistoryResponse,
  IbkrMarketDataSnapshot,
  IbkrPortfolioAccount,
  IbkrPortfolioSummary,
  IbkrPosition,
  IbkrSecdefByConidResponse,
  IbkrSecdefInfo,
  IbkrSecdefResponse,
  IbkrSecdefSearchResult,
  IbkrSecdefStrikesResponse,
  IbkrStockContract,
  IbkrStockListing,
  IbkrStocksResponse,
  IbkrSwitchAccountResponse,
  IbkrTrade,
  IbkrTransaction,
  IbkrTransactionsResponse,
  IbkrWhatIfResponse,
} from "./ibkrApiTypes.js";
import { normalizeOptionContract, parseOsiOptionSymbol } from "./optionContract.js";
import {
  normalizeDerivativeContract,
  normalizeDerivativeDataAvailability,
} from "./derivativeContract.js";
import {
  IbkrRequestScheduler,
  type IbkrRequestErrorClassification,
  type IbkrRequestPriority,
  type IbkrRequestSchedulerOptions,
  type IbkrRequestTelemetry,
} from "./requestScheduler.js";

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

interface PriceHistoryCandidate {
  conid: number;
  symbol: string;
  securityType: PriceHistorySecurityType;
  exchange?: string;
  supportsSmartOptions: boolean;
}

/** An optionable underlying resolved and primed in the current IBKR session. */
interface OptionUnderlying {
  conid: number;
  symbol: string;
}

interface OptionDiscoveryResult {
  contracts: OptionContract[];
  malformedDefinitionCount: number;
}

type SafeTradingDiagnostics = TradingDiagnostics & {
  authenticated: true;
  connected: true;
  competingSession: false;
  environment: BrokerEnvironment;
};

/** Live market-data snapshot field 78 = position's P&L for the current day. */
const DAY_PNL_FIELD = "78";
const OPTION_QUOTE_FIELDS = [
  "84", // Bid
  "86", // Ask
  "87", // Formatted volume
  "6509", // Market data availability
  "7308", // Delta
  "7638", // Option open interest
  "7762", // Unformatted volume
].join(",");
const DERIVATIVE_QUOTE_FIELDS = [
  "31", // Last
  "84", // Bid
  "86", // Ask
  "6509", // Market data availability
  "7308", // Delta
  "7633", // Implied volatility
  "7635", // Mark price
  "7638", // Option open interest
  "7762", // Unformatted volume
].join(",");
const DERIVATIVE_REFERENCE_QUOTE_FIELDS = [
  "31", // Last
  "55", // Symbol
  "84", // Bid
  "86", // Ask
  "6509", // Market data availability
  "7635", // Mark price when supplied
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
const OPTION_SECDEF_INFO_BATCH_SIZE = 8;
const OPTION_MARKETDATA_BATCH_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const IBKR_STATUS_FILTERS: Readonly<Record<string, string>> = {
  CANCELED: "cancelled",
  CANCELLED: "cancelled",
  FILLED: "filled",
  PENDING_CANCEL: "pending_cancel",
  PENDING_SUBMIT: "pending_submit",
  PRE_SUBMITTED: "pre_submitted",
  SUBMITTED: "submitted",
};
const IBKR_WORKING_STATUSES = new Set([
  "API_PENDING",
  "PENDING_SUBMIT",
  "PRE_SUBMITTED",
  "SUBMITTED",
  "PENDING_CANCEL",
]);
const RECOVERY_TERMINAL_ORDER_FILTERS = ["filled", "cancelled", "inactive"] as const;

interface DecodedOrderSubmission {
  responseIsArray: boolean;
  orders: DerivativeSubmittedOrder[];
  rawOrderResponses: Map<DerivativeSubmittedOrder, Readonly<Record<string, unknown>>>;
  invalidClientOrderIdentityOrders: Set<DerivativeSubmittedOrder>;
  pendingCancelOrderIds: string[];
  warnings: OrderWarning[];
  errors: BrokerErrorDetail[];
  unrecognizedResponses: unknown[];
}

interface RecoveryGraphTerminalCandidates {
  byNode: Map<string, IbkrLiveOrder[]>;
  linkedOrders: IbkrLiveOrder[];
  observedResponses: unknown[];
  invalidAttachedEvidence: boolean;
  terminalSnapshotLookupFailed: boolean;
}

/** Extract the canonical OSI symbol embedded in an IBKR option description. */
function extractOsiPositionSymbol(contractDescription: string): string | undefined {
  return /\[([A-Z]+\s*\d{6}[CP]\d{8})\s+\d+\]\s*$/.exec(contractDescription)?.[1];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseRetryAfter(raw: unknown, now: number): number | undefined {
  const asString = typeof raw === "string" ? raw.trim() : undefined;
  if (!asString) return undefined;

  const numeric = Number(asString);
  const numericMs = Math.ceil(numeric * 1000);
  if (Number.isSafeInteger(numericMs) && numericMs > 0) return numericMs;

  const date = Date.parse(asString);
  if (!Number.isNaN(date)) {
    const ms = Math.max(0, date - now);
    if (ms > 0) return ms;
  }

  return undefined;
}

function isUnknownRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isBrokerageSessionInput(input: unknown): input is { compete: boolean; publish: boolean } {
  return (
    isUnknownRecord(input) &&
    typeof input["compete"] === "boolean" &&
    typeof input["publish"] === "boolean"
  );
}

/**
 * One listing that `iserver/secdef/search` reports under an exact symbol (#671).
 *
 * IBKR answers a plain ticker with every listing that carries it, and several of them can be
 * genuinely different instruments. `UNH` returns both the NYSE common stock and a Canadian
 * Depositary Receipt on Toronto whose options trade on `CDE`; `NFLX` returns the same pair. Only
 * one of them owns the SMART-routed US options a caller means, so a resolver that demands a
 * single search row refuses these symbols outright.
 */
interface SecdefListing {
  readonly conid: number;
  readonly symbol: string;
  /** Whether this listing routes options on SMART, which identifies the US listing. */
  readonly supportsSmartOptions: boolean;
  /** Exchanges the matched asset-class section names, for an operator-readable refusal. */
  readonly exchanges: readonly string[];
  /** IBKR's own description of the listing, when it supplies one. */
  readonly description: string | null;
}

/**
 * Every distinct listing of an exact symbol that carries a section of one asset class (#671).
 *
 * Duplicate conids collapse: IBKR repeats a listing across sections, and the same contract twice
 * is one candidate, not an ambiguity. A symbol that does not match exactly is never a candidate,
 * because a foreign listing under a different ticker is a different instrument.
 */
function secdefListings(
  search: readonly IbkrSecdefSearchResult[],
  symbol: string,
  assetClass: string
): SecdefListing[] {
  const requested = symbol.trim().toUpperCase();
  const wanted = assetClass.trim().toUpperCase();
  const listings = search.flatMap((item): SecdefListing[] => {
    if (item.symbol?.trim().toUpperCase() !== requested) return [];
    const conid = Number(item.conid);
    if (!Number.isSafeInteger(conid) || conid <= 0) return [];
    const sections = Array.isArray(item.sections) ? item.sections : [];
    const matched = sections.filter((section) => section.secType?.trim().toUpperCase() === wanted);
    if (matched.length === 0) return [];
    const exchanges = [
      ...new Set(
        matched.flatMap((section) =>
          (section.exchange ?? "")
            .split(";")
            .map((name) => name.trim().toUpperCase())
            .filter(Boolean)
        )
      ),
    ];
    // An empty label is no label, so it falls through to the next source rather than becoming
    // an empty description in an operator message.
    const labels = [item.companyHeader?.trim(), item.description?.trim()];
    const description = labels.find((label) => label !== undefined && label !== "") ?? null;
    return [
      {
        conid,
        symbol: requested,
        supportsSmartOptions: supportsSmartOptions(sections),
        exchanges,
        description,
      },
    ];
  });
  return [...new Map(listings.map((listing) => [listing.conid, listing])).values()];
}

/** The listings that route options on SMART, which is the US listing a caller means. */
function smartOptionListings(listings: readonly SecdefListing[]): SecdefListing[] {
  return listings.filter((listing) => listing.supportsSmartOptions);
}

/**
 * Narrow listings to the SMART-routed one, keeping them all when none routes SMART (#671).
 *
 * The fallback matters: futures options and other non-SMART series never advertise SMART, and
 * dropping every candidate there would refuse a symbol that is not ambiguous at all.
 */
function preferSmartOptionListings(listings: readonly SecdefListing[]): SecdefListing[] {
  const smart = smartOptionListings(listings);
  return smart.length > 0 ? smart : [...listings];
}

/**
 * Name the competing listings so an operator can pass an explicit `tradingClass` or conid (#671).
 *
 * It reports the conid, IBKR's description, and the exchanges of each listing. It carries no
 * account identity, no order identity, and no credentials.
 */
function describeSecdefListings(listings: readonly SecdefListing[]): string {
  return listings
    .map((listing) => {
      const venue = listing.exchanges.length > 0 ? listing.exchanges.join("/") : "no exchange";
      const description = listing.description === null ? "" : ` ${listing.description}`;
      return `conid ${String(listing.conid)}${description} (${venue})`;
    })
    .join("; ");
}

function supportsSmartOptions(sections: unknown): boolean {
  if (!Array.isArray(sections)) return false;
  return sections.some((section) => {
    if (!isUnknownRecord(section)) return false;
    const securityType = section["secType"];
    const exchange = section["exchange"];
    return (
      typeof securityType === "string" &&
      securityType.trim().toUpperCase() === "OPT" &&
      typeof exchange === "string" &&
      exchange.split(";").some((name) => name.trim().toUpperCase() === "SMART")
    );
  });
}

const PRICE_HISTORY_SECURITY_TYPES = new Set<string>([
  "STK",
  "IND",
  "OPT",
  "FUT",
  "FOP",
  "CASH",
  "CFD",
  "WAR",
  "FUND",
  "BOND",
  "CMDTY",
]);

function isPriceHistorySecurityType(value: string): value is PriceHistorySecurityType {
  return PRICE_HISTORY_SECURITY_TYPES.has(value);
}

function isFiniteHistoryBar(
  bar: IbkrMarketDataHistoryBar
): bar is Required<IbkrMarketDataHistoryBar> {
  return [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v].every(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
}

function isHeadersLike(input: unknown): input is { get(name: string): string | null } {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { get?: unknown }).get === "function"
  );
}

function isIbkrTrade(input: unknown): input is IbkrTrade {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return (
    (record["account"] === undefined || typeof record["account"] === "string") &&
    (record["accountCode"] === undefined || typeof record["accountCode"] === "string") &&
    (record["order_ref"] === undefined || typeof record["order_ref"] === "string") &&
    (record["order_id"] === undefined ||
      typeof record["order_id"] === "string" ||
      typeof record["order_id"] === "number")
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

interface IbkrRequestInput {
  path: string;
  method?: string;
  params?: Record<string, string | number | boolean | null | undefined>;
  data?: object;
}

type IbkrRequestRetryPolicy = "SAFE_READ" | "PRICE_HISTORY" | "SINGLE_ATTEMPT";

/** Controls one option-chain or expiry-discovery operation. */
/** The optional count fields of {@link OptionDiscoveryTelemetry}; each defaults to 0. */
type OptionDiscoveryTelemetryCount =
  | "definitionRequestCount"
  | "snapshotBatchCount"
  | "listedStrikeCount"
  | "selectedStrikeCount"
  | "cachedDefinitionCount";

/** Refuse a band that is not made of finite numbers, or that can never select a strike. */
function normalizeStrikeRange(range?: OptionStrikeRange): OptionStrikeRange | undefined {
  if (range === undefined) return undefined;
  const { min, max } = range;
  if (min !== undefined && !Number.isFinite(min)) {
    throw new TypeError("Option strike range min must be a finite number");
  }
  if (max !== undefined && !Number.isFinite(max)) {
    throw new TypeError("Option strike range max must be a finite number");
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new TypeError(`Option strike range min ${String(min)} is above max ${String(max)}`);
  }
  if (min === undefined && max === undefined) return undefined;
  return range;
}

/** The first pair of contracts that share one durable symbol, or `null` when every one is unique. */
function firstSymbolCollision(
  contracts: readonly OptionContract[]
): { symbol: string; first: OptionContract; second: OptionContract } | null {
  const bySymbol = new Map<string, OptionContract>();
  for (const contract of contracts) {
    const seen = bySymbol.get(contract.symbol);
    if (seen !== undefined) return { symbol: contract.symbol, first: seen, second: contract };
    bySymbol.set(contract.symbol, contract);
  }
  return null;
}

/** One stable memo token for a band, so a narrowed result cannot answer a wider request. */
function strikeRangeKey(range?: OptionStrikeRange): string {
  if (range === undefined) return "*";
  return `${String(range.min ?? "-inf")}..${String(range.max ?? "+inf")}`;
}

/** A strike that IBKR does not report as a finite number is never selected. */
function strikeInRange(strike: number, range?: OptionStrikeRange): boolean {
  if (!Number.isFinite(strike)) return false;
  if (range === undefined) return true;
  if (range.min !== undefined && strike < range.min) return false;
  if (range.max !== undefined && strike > range.max) return false;
  return true;
}

/** A cached record is used only when it is a whole contract and it answers the key it is filed under. */
function isCachedOptionContract(value: unknown, key: OptionDefinitionCacheKey): boolean {
  if (!isUnknownRecord(value)) return false;
  const { conid, symbol, underlying, tradingClass, expiry, strike, right } = value;
  if (
    typeof conid !== "number" ||
    !Number.isFinite(conid) ||
    typeof symbol !== "string" ||
    symbol.length === 0 ||
    typeof underlying !== "string" ||
    underlying.length === 0 ||
    typeof expiry !== "string" ||
    expiry.length === 0 ||
    typeof strike !== "number" ||
    strike !== key.strike ||
    right !== key.right
  ) {
    return false;
  }
  // The class is part of identity, so a record that predates it, or that lost it, is a miss and
  // the broker answers. `null` is a stated absence and is accepted; `undefined` is a record shape
  // this version does not recognize.
  if (tradingClass !== null && (typeof tradingClass !== "string" || tradingClass.length === 0)) {
    return false;
  }
  // A record whose symbol does not carry its own root is not the identity it claims to be.
  const parsed = parseOsiOptionSymbol(symbol);
  return parsed !== null && parsed.root === (tradingClass ?? underlying);
}

export interface OptionDiscoveryOptions {
  /** Stop this operation without canceling work owned by another caller. */
  signal?: AbortSignal;
  /**
   * Resolve only the strikes inside this inclusive band.
   *
   * One security definition costs one paced `secdef/info` request, so a month that lists thousands
   * of strikes costs thousands of requests. A caller that can name the strikes it uses makes the
   * cost proportional to that band. Without a band every listed strike is resolved.
   */
  strikeRange?: OptionStrikeRange;
}

export interface IbkrClientOptions {
  requestScheduler?: Omit<IbkrRequestSchedulerOptions, "classifyError" | "onTelemetry">;
  onRequestTelemetry?: (event: IbkrRequestTelemetry) => void;
  /** Receive safe contract and request metadata before each price-history request. */
  onPriceHistoryTelemetry?: (event: PriceHistoryTelemetry) => void;
  /** Receive safe timing and request counts for option-discovery phases. */
  onOptionDiscoveryTelemetry?: (event: OptionDiscoveryTelemetry) => void;
  /**
   * Supply resolved security definitions so discovery does not request them again.
   *
   * The cache is an accelerator and never an authority: a rejected read, a malformed record, or a
   * misaligned result is treated as a miss, and the broker then answers.
   */
  optionDefinitionCache?: OptionDefinitionCache;
}

/** Safe HTTP response evidence retained when the raw transport rejects a request. */
export interface IbkrHttpErrorResponse {
  status: number;
  body: string;
  retryAfter: string | null;
}

/** A typed HTTP failure from the IBKR transport. */
export class IbkrHttpError extends Error {
  readonly statusCode: number;

  constructor(
    message: string,
    readonly status: number,
    readonly response: IbkrHttpErrorResponse,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "IbkrHttpError";
    this.statusCode = status;
  }
}

/**
 * Typed broker rejection for documented IBKR error-object payloads outside order
 * submission result envelopes. Callers can catch this class to read the retained
 * {@link BrokerErrorDetail} without parsing free-form message text.
 */
export class IbkrBrokerResponseError extends Error {
  constructor(
    message: string,
    readonly detail: BrokerErrorDetail,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "IbkrBrokerResponseError";
  }
}

/** Typed contract-resolution failure raised before a price-history broker request. */
export class IbkrPriceHistoryContractError extends Error {
  constructor(
    message: string,
    readonly code:
      "CONTRACT_NOT_FOUND" | "CONTRACT_AMBIGUOUS" | "CONTRACT_INVALID" | "CONTRACT_MISMATCH",
    readonly candidates: readonly PriceHistoryContractCandidate[] = []
  ) {
    super(message);
    this.name = "IbkrPriceHistoryContractError";
  }
}

/** A daily history request for which IBKR did not return the full requested interval. */
export class IbkrInsufficientHistoryError extends Error {
  constructor(
    readonly symbol: string,
    readonly requestedStart: number,
    readonly requestedEnd: number,
    readonly availableStart: number | null,
    readonly availableEnd: number | null,
    options?: ErrorOptions
  ) {
    super(`IBKR returned insufficient daily history for ${symbol}`, options);
    this.name = "IbkrInsufficientHistoryError";
  }
}

/**
 * Typed IBKR Web API client implementing the broker-neutral {@link BrokerClient}.
 * Wraps the `ibkr-client` npm package, which performs the OAuth 1.0a
 * live-session-token handshake. Ports the data access from the Python PoC
 * (main.py): account summary, positions paging, and day-P/L snapshots.
 */
export class IbkrClient
  implements
    BrokerClient,
    IbkrSessionLifecycleClient,
    DerivativeDiscoveryClient,
    DerivativePreviewClient,
    DerivativeExecutionClient
{
  private readonly raw: RawIbkrClient;
  private initPromise?: Promise<void>;
  private logoutPromise?: Promise<void>;
  private closed = false;
  private accountCriticalSectionTail: Promise<void> = Promise.resolve();
  private accountIdPromise?: Promise<string>;
  private readonly optionDiscovery = new Map<string, Promise<OptionDiscoveryResult>>();
  private readonly optionDefinitionCache: OptionDefinitionCache | undefined;
  private readonly optionContractResolution = new Map<string, Promise<OptionContract | null>>();
  private readonly priceHistoryContractResolution = new Map<
    string,
    Promise<PriceHistoryContract>
  >();
  private readonly derivativeDiscovery = new Map<string, Promise<DerivativeContract[]>>();
  private readonly requestScheduler: IbkrRequestScheduler;
  private readonly requestNow: () => number;
  private secdefPrimingTail: Promise<void> = Promise.resolve();
  private readonly onPriceHistoryTelemetry: (event: PriceHistoryTelemetry) => void;
  private readonly onOptionDiscoveryTelemetry: (event: OptionDiscoveryTelemetry) => unknown;
  private readonly onRequestTelemetry: (event: IbkrRequestTelemetry) => void;

  constructor(config: IbkrOauth1Config, options: IbkrClientOptions = {}) {
    this.raw = new RawIbkrClientCtor(config);
    this.onPriceHistoryTelemetry = options.onPriceHistoryTelemetry ?? (() => undefined);
    this.onOptionDiscoveryTelemetry = options.onOptionDiscoveryTelemetry ?? (() => undefined);
    this.optionDefinitionCache = options.optionDefinitionCache;
    this.onRequestTelemetry = options.onRequestTelemetry ?? (() => undefined);
    const schedulerOptions = options.requestScheduler;
    this.requestNow = schedulerOptions?.now ?? (() => this.now());
    this.requestScheduler = new IbkrRequestScheduler({
      ...schedulerOptions,
      now: this.requestNow,
      sleep: schedulerOptions?.sleep ?? ((ms) => this.wait(ms)),
      random: schedulerOptions?.random ?? (() => this.random()),
      classifyError: (error) => this.classifyRequestError(error),
      ...(options.onRequestTelemetry === undefined
        ? {}
        : { onTelemetry: options.onRequestTelemetry }),
    });
  }

  /**
   * Obtain the live session token with the legacy competing-session behavior.
   *
   * @deprecated Use {@link initializeBrokerageSession} with explicit flags.
   */
  async init(): Promise<void> {
    this.assertOpen();
    this.initPromise ??= this.initializeBrokerageSession({ compete: true, publish: true });
    return this.initPromise;
  }

  async initializeBrokerageSession(input: { compete: boolean; publish: boolean }): Promise<void> {
    this.assertOpen();
    const rawInput: unknown = input;
    if (!isBrokerageSessionInput(rawInput)) {
      throw new TypeError("IBKR brokerage session initialization flags must be exact booleans");
    }
    try {
      await this.raw.init(rawInput.compete, rawInput.publish);
    } catch (error) {
      throw this.normalizeHttpError(error);
    }
    // IBKR is slow right after initialization; give the session a moment to settle.
    await this.wait(1000);
  }

  async renewBrokerageSession(input: { compete: false; publish: boolean }): Promise<void> {
    this.assertOpen();
    const rawInput: unknown = input;
    if (!isBrokerageSessionInput(rawInput) || rawInput.compete) {
      throw new TypeError(
        "IBKR brokerage session renewal requires compete false and an exact publish boolean"
      );
    }
    try {
      await this.raw.init(false, rawInput.publish);
    } catch (error) {
      throw this.normalizeHttpError(error);
    }
    await this.wait(1000);
  }

  async getSessionEvidence(): Promise<IbkrSessionEvidence> {
    this.assertOpen();
    const [status, rawAccounts] = await Promise.all([
      this.getAuthStatus(),
      this.req<unknown>({ path: "iserver/accounts" }),
    ]);
    const accounts = isUnknownRecord(rawAccounts) ? rawAccounts : {};
    return {
      authenticated: status.authenticated,
      competing: status.competing,
      connected: status.connected,
      accountIds: this.accountIdsOrNull(accounts["accounts"]),
      selectedAccountId:
        typeof accounts["selectedAccount"] === "string" ? accounts["selectedAccount"] : null,
      isPaper: this.booleanOrNull(accounts["isPaper"]),
    };
  }

  async tickle(): Promise<void> {
    this.assertOpen();
    await this.req<unknown>({ path: "tickle", method: "POST" });
  }

  async logout(): Promise<void> {
    this.assertOpen();
    this.logoutPromise ??= this.singleAttemptRequest<unknown>({
      path: "logout",
      method: "POST",
    }).then(() => undefined);
    return this.logoutPromise;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    delete this.accountIdPromise;
    this.optionDiscovery.clear();
    this.optionContractResolution.clear();
    this.priceHistoryContractResolution.clear();
    this.derivativeDiscovery.clear();
    return Promise.resolve();
  }

  async getAuthStatus(): Promise<AuthStatus> {
    this.assertOpen();
    const rawStatus = await this.req<unknown>({
      path: "iserver/auth/status",
      method: "POST",
    });
    const status = isUnknownRecord(rawStatus) ? rawStatus : {};
    return {
      authenticated: this.booleanOrNull(status["authenticated"]),
      competing: this.booleanOrNull(status["competing"]),
      connected: this.booleanOrNull(status["connected"]),
    };
  }

  async getTradingDiagnostics(accountId: string): Promise<TradingDiagnostics> {
    this.assertOpen();
    if (!accountId.trim()) throw new Error("An explicit IBKR account ID is required");
    const [status, rawAccounts] = await Promise.all([
      this.getAuthStatus(),
      this.req<unknown>({ path: "iserver/accounts" }),
    ]);
    const accounts = isUnknownRecord(rawAccounts) ? rawAccounts : {};
    const accountIds = this.accountIdsOrNull(accounts["accounts"]);
    if (!accountIds?.includes(accountId)) {
      throw new Error(`IBKR account ${accountId} is not available to this session`);
    }
    const rawFeatures = accounts["allowFeatures"];
    const features = isUnknownRecord(rawFeatures) ? rawFeatures : {};
    const rawAssetTypes = features["allowedAssetTypes"];
    return {
      accountId,
      selectedAccountId:
        typeof accounts["selectedAccount"] === "string" ? accounts["selectedAccount"] : null,
      environment:
        accounts["isPaper"] === true ? "paper" : accounts["isPaper"] === false ? "live" : null,
      authenticated: status.authenticated,
      connected: status.connected,
      competingSession: status.competing,
      marketDataAvailable: this.booleanOrNull(features["showGFIS"]),
      advisoryAssetPermissions:
        typeof rawAssetTypes === "string"
          ? rawAssetTypes
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          : [],
    };
  }

  async previewDerivativeCombo(
    request: DerivativeComboPreviewRequest
  ): Promise<DerivativeComboPreviewResult> {
    this.assertOpen();
    this.validateComboPreview(request);
    return this.withTradingMutation(
      request.accountId,
      "IBKR brokerage session is not safely authenticated for What-If",
      async (diagnostics) => {
        const conids = request.legs.map(({ contract }) => contract.conid).join(",");
        await this.req<unknown>({
          path: "iserver/marketdata/snapshot",
          params: { conids, fields: "6509" },
        });
        const response = await this.singleAttemptRequest<IbkrWhatIfResponse>({
          path: `iserver/account/${request.accountId}/orders/whatif`,
          method: "POST",
          data: { orders: [this.comboOrderTicket(request)] },
        });
        return this.normalizeComboPreview(request.accountId, diagnostics, response);
      }
    );
  }

  async submitDerivativeCombo(
    request: DerivativeComboExecutionRequest
  ): Promise<DerivativeOrderSubmissionResult> {
    this.assertOpen();
    this.validateComboPreview(request);
    if (!request.clientOrderId.trim() || request.clientOrderId.length > 64) {
      throw new Error("Client order ID must contain 1 to 64 characters");
    }
    const cmeOperatorMetadata = this.cmeOperatorMetadata(
      request.legs[0].contract.assetClass,
      request
    );
    return this.withTradingMutation(
      request.accountId,
      "IBKR brokerage session is not safely authenticated for submission",
      async () => {
        const response = await this.singleAttemptRequest<
          IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[]
        >({
          path: `iserver/account/${request.accountId}/orders`,
          method: "POST",
          data: {
            orders: [
              {
                ...this.comboOrderTicket(request),
                cOID: request.clientOrderId,
                ...cmeOperatorMetadata,
              },
            ],
          },
        });
        return this.normalizeOrderSubmission(response, request.clientOrderId);
      }
    );
  }

  async submitDerivativeSingleOrder(
    request: DerivativeSingleOrderRequest
  ): Promise<DerivativeOrderSubmissionResult> {
    this.assertOpen();
    this.validateSingleOrder(request);
    const cmeOperatorMetadata = this.cmeOperatorMetadata(request.contract.assetClass, request);
    return this.withTradingMutation(
      request.accountId,
      "IBKR brokerage session is not safely authenticated for submission",
      async () => {
        const response = await this.singleAttemptRequest<
          IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[]
        >({
          path: `iserver/account/${request.accountId}/orders`,
          method: "POST",
          data: {
            orders: [
              {
                ...this.singleOrderTicket(request),
                ...(request.clientOrderId !== undefined ? { cOID: request.clientOrderId } : {}),
                ...(request.parentId !== undefined ? { parentId: request.parentId } : {}),
                ...cmeOperatorMetadata,
              },
            ],
          },
        });
        return this.normalizeOrderSubmission(response, request.clientOrderId ?? null);
      }
    );
  }

  async submitDerivativeContingentOrders(request: {
    accountId: string;
    parent: DerivativeContingentParentOrderRequest;
    child: DerivativeContingentChildOrderRequest;
  }): Promise<DerivativeMultiOrderResult> {
    this.assertOpen();
    const { accountId, parent, child } = request;
    if (!accountId.trim()) throw new Error("An explicit IBKR account ID is required");
    if (parent.accountId !== accountId || child.accountId !== accountId) {
      throw new Error("Contingent parent and child orders must target the exact same account");
    }
    this.validateSingleOrderFields(parent);
    this.validateSingleOrderFields(child);
    if (
      typeof parent.clientOrderId !== "string" ||
      !parent.clientOrderId.trim() ||
      parent.clientOrderId.length > 64
    ) {
      throw new Error("Parent client order ID must contain 1 to 64 characters");
    }
    if ("clientOrderId" in child || "parentId" in child) {
      throw new Error("Contingent child identity is derived from the parent order");
    }
    const parentMetadata = this.cmeOperatorMetadata(parent.contract.assetClass, parent);
    const childMetadata = this.cmeOperatorMetadata(child.contract.assetClass, child);
    return this.withTradingMutation(
      accountId,
      "IBKR brokerage session is not safely authenticated for submission",
      async () => {
        const response = await this.singleAttemptRequest<
          IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[]
        >({
          path: `iserver/account/${accountId}/orders`,
          method: "POST",
          data: {
            orders: [
              {
                ...this.singleOrderTicket(parent),
                cOID: parent.clientOrderId,
                ...parentMetadata,
              },
              {
                ...this.singleOrderTicket(child),
                parentId: parent.clientOrderId,
                ...childMetadata,
              },
            ],
          },
        });
        return this.normalizeMultiOrderSubmission(response, parent.clientOrderId, accountId);
      }
    );
  }

  async submitDerivativeOrderGraph(
    request: DerivativeOrderGraphRequest
  ): Promise<DerivativeOrderGraphResult> {
    this.assertOpen();
    this.validateOrderGraph(request);
    return this.withTradingMutation(
      request.accountId,
      "IBKR brokerage session is not safely authenticated for submission",
      async () => {
        const response = await this.singleAttemptRequest<
          IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[]
        >({
          path: `iserver/account/${request.accountId}/orders`,
          method: "POST",
          data: { orders: request.nodes.map((node) => this.graphOrderTicket(request, node)) },
        });
        return this.normalizeOrderGraphSubmission(response, request, []);
      }
    );
  }

  async acknowledgeDerivativeOrderGraphWarning(input: {
    continuation: DerivativeOrderGraphWarningContinuation;
    confirmed: true;
  }): Promise<DerivativeOrderGraphResult> {
    this.assertOpen();
    if ((input.confirmed as unknown) !== true)
      throw new Error("Order warning confirmation must be true");
    this.validateOrderGraph(input.continuation.request);
    if (!input.continuation.replyId.trim())
      throw new Error("An exact warning reply ID is required");
    return this.withTradingMutation(
      input.continuation.request.accountId,
      "IBKR brokerage session is not safely authenticated for submission",
      async () => {
        const response = await this.singleAttemptRequest<
          IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[]
        >({
          path: `iserver/reply/${encodeURIComponent(input.continuation.replyId)}`,
          method: "POST",
          data: { confirmed: true },
        });
        return this.normalizeOrderGraphSubmission(
          response,
          input.continuation.request,
          input.continuation.members
        );
      }
    );
  }

  async recoverDerivativeOrderGraph(
    input: DerivativeOrderGraphLookup,
    request: DerivativeOrderGraphRequest
  ): Promise<DerivativeOrderGraphResult> {
    this.assertOpen();
    this.validateOrderGraph(request);
    if (input.accountId !== request.accountId)
      throw new Error("Graph recovery account does not match request");
    if (
      input.rootClientOrderId !== undefined &&
      input.rootClientOrderId !== request.rootClientOrderId
    ) {
      throw new Error("Root client order ID does not match the requested graph");
    }
    if (input.orderId !== undefined && !input.orderId.trim()) {
      throw new Error("An exact broker order ID is required for graph recovery");
    }
    return this.withAccountCriticalSection(async () => {
      await this.prepareBrokerageAccount(input.accountId);
      const response = await this.req<IbkrLiveOrdersResponse>({
        path: "iserver/account/orders",
        params: { accountId: input.accountId },
      });
      const flattenedActiveSnapshot = this.resolveFlattenedGraphParentAliases(
        request,
        this.flattenCompleteOrderSnapshot(response)
      );
      const activeSnapshotIncomplete = flattenedActiveSnapshot === null;
      const invalidActiveAccountEvidence =
        flattenedActiveSnapshot?.some(
          ({ order }) => !this.orderHasExactAccount(order, input.accountId)
        ) ?? false;
      const invalidNestedActiveEvidence =
        flattenedActiveSnapshot?.some(
          ({ order, nestedParent }) =>
            nestedParent !== null &&
            !this.recoveryGraphOrderMayBeAttached(request, order) &&
            this.recoveryGraphOrderIsAttached(request, nestedParent)
        ) ?? false;
      const accountOrders = (flattenedActiveSnapshot ?? [])
        .map(({ order }) => order)
        .filter((order) => this.orderHasExactAccount(order, input.accountId));
      const activeMatchesByMember = new Map<string, IbkrLiveOrder[]>();
      const knownActiveOrders = accountOrders.filter(
        (order) => input.orderId !== undefined && this.recoveryOrderId(order) === input.orderId
      );
      const conflictingKnownActiveOrders = knownActiveOrders.filter(
        (order) => !this.recoveryGraphOrderMayBeAttached(request, order)
      );
      const observedCandidates: unknown[] =
        activeSnapshotIncomplete || invalidActiveAccountEvidence || invalidNestedActiveEvidence
          ? [response]
          : [...conflictingKnownActiveOrders];
      observedCandidates.push(
        ...accountOrders.filter((order) => this.recoveryGraphOrderMayBeAttached(request, order))
      );
      for (const node of request.nodes) {
        const matches = accountOrders.filter(
          (order) =>
            this.terminalOrderTicketIsValid(order) &&
            this.orderHasValidRecoveryStatus(order) &&
            this.recoveryOrderMatchesGraphNode(request, node, order)
        );
        activeMatchesByMember.set(node.memberId, matches);
      }
      const selected = new Map<string, IbkrLiveOrder>();
      const usedOrderIds = new Set<string>();
      for (const node of request.nodes) {
        const matches = activeMatchesByMember.get(node.memberId) ?? [];
        const [match] = matches;
        if (matches.length !== 1 || match === undefined) continue;
        const orderId = this.recoveryOrderId(match);
        if (orderId === undefined) continue;
        if (usedOrderIds.has(orderId)) continue;
        usedOrderIds.add(orderId);
        selected.set(node.memberId, match);
      }
      const unresolved = request.nodes.filter((node) => !selected.has(node.memberId));
      const terminalEvidence = await this.findRecoveryGraphTerminalCandidates(
        input.accountId,
        request,
        input.orderId
      );
      const conflictingKnownActiveTickets = knownActiveOrders.filter((activeOrder) =>
        terminalEvidence.linkedOrders.some(
          (terminalOrder) =>
            this.recoveryOrderId(terminalOrder) === input.orderId &&
            this.terminalOrderTicketConflicts(activeOrder, terminalOrder)
        )
      );
      this.reconcileSelectedGraphMembers(request, selected, terminalEvidence);
      if (unresolved.length > 0) {
        const assignments = this.assignRecoveryGraphCandidates(
          unresolved,
          terminalEvidence.byNode,
          usedOrderIds
        );
        for (const node of unresolved) {
          const order = assignments.get(node.memberId);
          if (order === undefined) continue;
          selected.set(node.memberId, order);
          const orderId = this.recoveryOrderId(order);
          if (orderId !== undefined) usedOrderIds.add(orderId);
          observedCandidates.push(order);
        }
      }
      observedCandidates.push(...terminalEvidence.observedResponses);
      if (terminalEvidence.invalidAttachedEvidence) {
        observedCandidates.push({ reason: "Invalid or conflicting terminal broker evidence" });
      }
      const selectedCandidates = [...selected.values()];
      const requestedOrderIdMissing =
        input.orderId !== undefined &&
        !selectedCandidates.some((order) => this.recoveryOrderId(order) === input.orderId);
      const members = request.nodes.map((node) => {
        const order = selected.get(node.memberId);
        return this.graphMemberEvidence(request, node, order);
      });
      const ids = members.flatMap(({ orderId }) => (orderId === null ? [] : [orderId]));
      const hasDistinctOrderIds = new Set(ids).size === request.nodes.length;
      const linkedOrderIds = new Set<string>();
      let linkedOrderMissingBrokerId = false;
      for (const order of accountOrders) {
        if (!this.recoveryGraphOrderMayBeAttached(request, order)) continue;
        if (!this.recoveryGraphOrderIsAttached(request, order)) {
          linkedOrderMissingBrokerId = true;
          continue;
        }
        const orderId = this.recoveryOrderId(order);
        if (orderId === undefined) {
          linkedOrderMissingBrokerId = true;
          continue;
        }
        linkedOrderIds.add(orderId);
      }
      for (const order of terminalEvidence.linkedOrders) {
        const orderId = this.recoveryOrderId(order);
        if (orderId === undefined) {
          linkedOrderMissingBrokerId = true;
          continue;
        }
        linkedOrderIds.add(orderId);
      }
      const selectedOrderIds = new Set(
        selectedCandidates.flatMap((order) => {
          const orderId = this.recoveryOrderId(order);
          return orderId === undefined ? [] : [orderId];
        })
      );
      if (
        selected.size !== request.nodes.length ||
        !hasDistinctOrderIds ||
        linkedOrderMissingBrokerId ||
        [...linkedOrderIds].some((orderId) => !selectedOrderIds.has(orderId)) ||
        requestedOrderIdMissing ||
        activeSnapshotIncomplete ||
        invalidActiveAccountEvidence ||
        invalidNestedActiveEvidence ||
        conflictingKnownActiveOrders.length > 0 ||
        conflictingKnownActiveTickets.length > 0 ||
        terminalEvidence.invalidAttachedEvidence ||
        terminalEvidence.terminalSnapshotLookupFailed ||
        members.some(({ status }) => status === "UNKNOWN" || status === "WARNING_PENDING")
      ) {
        return {
          state: "recovery_required",
          rootClientOrderId: request.rootClientOrderId,
          members,
          reasons: [
            "Exact graph recovery found incomplete, duplicated, or ambiguous member evidence",
          ],
          warnings: [],
          errors: [],
          unrecognizedResponses: observedCandidates,
        };
      }
      return {
        state: "accepted",
        rootClientOrderId: request.rootClientOrderId,
        members: this.attachGraphParentOrderIds(members),
        warnings: [],
      };
    });
  }

  private reconcileSelectedGraphMembers(
    request: DerivativeOrderGraphRequest,
    selected: Map<string, IbkrLiveOrder>,
    terminalEvidence: RecoveryGraphTerminalCandidates
  ): void {
    for (const node of request.nodes) {
      const selectedOrder = selected.get(node.memberId);
      const selectedOrderId =
        selectedOrder === undefined ? undefined : this.recoveryOrderId(selectedOrder);
      if (selectedOrderId === undefined) continue;

      const terminalMatches = new Map<string, IbkrLiveOrder>();
      for (const order of terminalEvidence.byNode.get(node.memberId) ?? []) {
        const orderId = this.recoveryOrderId(order);
        if (orderId === selectedOrderId) terminalMatches.set(orderId, order);
      }
      const terminalLinked =
        terminalMatches.size > 0 ||
        terminalEvidence.linkedOrders.some(
          (order) =>
            this.recoveryOrderId(order) === selectedOrderId && this.isTerminalRecoveryOrder(order)
        );
      if (!terminalLinked) continue;

      if (terminalMatches.size !== 1) {
        terminalEvidence.invalidAttachedEvidence = true;
        continue;
      }
      const [terminalOrder] = terminalMatches.values();
      if (terminalOrder !== undefined) selected.set(node.memberId, terminalOrder);
    }
  }

  private isTerminalRecoveryOrder(order: IbkrLiveOrder): boolean {
    const status = this.canonicalIbkrOrderStatus(
      order.order_status ?? order.orderStatus ?? order.status
    );
    return (
      status === "FILLED" ||
      status === "CANCELLED" ||
      status === "INACTIVE" ||
      status === "REJECTED"
    );
  }

  private async findRecoveryGraphTerminalCandidates(
    accountId: string,
    request: DerivativeOrderGraphRequest,
    knownOrderId?: string
  ): Promise<RecoveryGraphTerminalCandidates> {
    const graphClientOrderIds = this.graphClientOrderIds(request);
    const byNode = new Map<string, IbkrLiveOrder[]>();
    for (const node of request.nodes) byNode.set(node.memberId, []);
    const linkedOrders: IbkrLiveOrder[] = [];
    const observedResponses: unknown[] = [];
    let invalidAttachedEvidence = false;
    let terminalSnapshotLookupFailed = false;

    const candidateOrderIds = new Set<string>();
    if (knownOrderId !== undefined) candidateOrderIds.add(knownOrderId);
    const terminalOrdersById = new Map<string, IbkrLiveOrder>();
    const exactStatusAttachmentOrderIds = new Set<string>();

    for (const filter of RECOVERY_TERMINAL_ORDER_FILTERS) {
      try {
        const response = await this.req<IbkrLiveOrdersResponse>({
          path: "iserver/account/orders",
          params: { accountId, filters: filter },
        });
        const flattenedSnapshot = this.resolveFlattenedGraphParentAliases(
          request,
          this.flattenCompleteOrderSnapshot(response)
        );
        if (flattenedSnapshot === null) {
          terminalSnapshotLookupFailed = true;
          observedResponses.push({ source: "terminal_order_snapshot", filter, response });
          continue;
        }
        for (const { order, nestedParent } of flattenedSnapshot) {
          if (!this.recoveryGraphOrderMayBeAttached(request, order)) {
            if (knownOrderId !== undefined && this.recoveryOrderId(order) === knownOrderId) {
              observedResponses.push(order);
              invalidAttachedEvidence = true;
              continue;
            }
            if (
              nestedParent === null ||
              !this.recoveryGraphOrderIsAttached(request, nestedParent)
            ) {
              continue;
            }
            observedResponses.push(order);
            linkedOrders.push(order);
            invalidAttachedEvidence = true;
            continue;
          }
          observedResponses.push(order);
          if (!this.recoveryGraphOrderIsAttached(request, order)) {
            linkedOrders.push(order);
            invalidAttachedEvidence = true;
            continue;
          }
          if (!this.orderHasExactAccount(order, accountId)) {
            invalidAttachedEvidence = true;
            continue;
          }
          if (!this.terminalOrderTicketIsValid(order) || !this.orderHasValidRecoveryStatus(order)) {
            linkedOrders.push(order);
            invalidAttachedEvidence = true;
            continue;
          }
          const orderId = this.recoveryOrderId(order);
          if (orderId === undefined) {
            linkedOrders.push(order);
            invalidAttachedEvidence = true;
            continue;
          }
          const previousOrder = terminalOrdersById.get(orderId);
          if (
            previousOrder !== undefined &&
            (this.terminalOrderTicketConflicts(previousOrder, order) ||
              this.recoveryGraphAttachmentKey(request, previousOrder) !==
                this.recoveryGraphAttachmentKey(request, order))
          ) {
            invalidAttachedEvidence = true;
            linkedOrders.push(order);
            continue;
          }
          terminalOrdersById.set(orderId, order);
          linkedOrders.push(order);
          candidateOrderIds.add(orderId);
        }
      } catch (error) {
        terminalSnapshotLookupFailed = true;
        observedResponses.push({
          source: "terminal_order_snapshot",
          filter,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const tradeEvidenceById = new Map<string, IbkrLiveOrder>();
    try {
      const response = await this.req<unknown>({
        path: "iserver/account/trades",
        params: { days: 7 },
      });
      if (Array.isArray(response)) {
        for (const rawTrade of response) {
          if (typeof rawTrade !== "object" || rawTrade === null || Array.isArray(rawTrade))
            continue;
          const tradeRecord = rawTrade as Record<string, unknown>;
          const orderRef = this.trimmedString(tradeRecord["order_ref"]);
          const parentRef = this.recoveryOrderId({
            order_id: tradeRecord["parent_order_ref"],
            orderId: tradeRecord["parentOrderRef"],
          });
          if (
            (orderRef === null || !graphClientOrderIds.has(orderRef)) &&
            (parentRef === undefined || !graphClientOrderIds.has(parentRef))
          ) {
            continue;
          }
          const accounts = [tradeRecord["account"], tradeRecord["accountCode"]].filter(
            (value) => value !== undefined
          );
          if (
            accounts.length > 0 &&
            accounts.every((value) => typeof value === "string" && value !== accountId)
          ) {
            continue;
          }
          if (
            accounts.length === 0 ||
            accounts.some((value) => typeof value !== "string" || value !== accountId) ||
            !isIbkrTrade(rawTrade)
          ) {
            observedResponses.push(rawTrade);
            invalidAttachedEvidence = true;
            continue;
          }
          const orderId = this.recoveryOrderId(rawTrade);
          if (orderId === undefined) {
            observedResponses.push(rawTrade);
            invalidAttachedEvidence = true;
            continue;
          }
          candidateOrderIds.add(orderId);
          tradeEvidenceById.set(orderId, {
            ...rawTrade,
            account: accountId,
            order_id: orderId,
          });
        }
      }
    } catch {
      // Exact broker IDs and terminal order snapshots remain usable when trade history is unavailable.
    }

    for (const orderId of candidateOrderIds) {
      const terminalOrder = terminalOrdersById.get(orderId);
      try {
        const order = await this.req<IbkrLiveOrder>({
          path: `iserver/account/order/status/${encodeURIComponent(orderId)}`,
        });
        observedResponses.push(order);
        if (!this.orderMatchesExactRecoveryIdentity(order, accountId, orderId)) {
          invalidAttachedEvidence = true;
          continue;
        }
        // Prefer graph attachment from a snapshot when it exists. IBKR's exact status response can
        // omit every client-order identity field. The caller's durable broker ID can establish that
        // one member's attachment when the status response contains no conflicting attachment
        // evidence and its complete ticket identifies exactly one requested node below.
        const resolvedOrder = terminalOrder === undefined ? order : { ...terminalOrder, ...order };
        if (!this.orderHasValidRecoveryStatus(resolvedOrder)) {
          invalidAttachedEvidence = true;
          terminalOrdersById.delete(orderId);
          continue;
        }
        if (!this.terminalOrderTicketIsValid(resolvedOrder)) {
          invalidAttachedEvidence = true;
          terminalOrdersById.delete(orderId);
          continue;
        }
        if (
          terminalOrder !== undefined &&
          this.terminalOrderTicketConflicts(terminalOrder, order)
        ) {
          invalidAttachedEvidence = true;
          terminalOrdersById.delete(orderId);
          continue;
        }
        if (
          terminalOrder !== undefined &&
          this.recoveryGraphAttachmentKey(request, terminalOrder) !==
            this.recoveryGraphAttachmentKey(request, resolvedOrder)
        ) {
          invalidAttachedEvidence = true;
          terminalOrdersById.delete(orderId);
          continue;
        }
        if (!this.recoveryGraphOrderIsAttached(request, resolvedOrder)) {
          const callerNamedStatusWithoutAttachment =
            orderId === knownOrderId &&
            terminalOrder === undefined &&
            !this.orderHasRecoveryAttachmentEvidence(order);
          if (!callerNamedStatusWithoutAttachment) {
            invalidAttachedEvidence = true;
            terminalOrdersById.delete(orderId);
            continue;
          }
          exactStatusAttachmentOrderIds.add(orderId);
        }
        terminalOrdersById.set(orderId, resolvedOrder);
        if (terminalOrder === undefined) linkedOrders.push(resolvedOrder);
      } catch (error) {
        observedResponses.push({
          source: "terminal_order_status",
          orderId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (terminalOrder === undefined) {
          const tradeEvidence = tradeEvidenceById.get(orderId);
          if (tradeEvidence !== undefined) {
            linkedOrders.push(tradeEvidence);
            observedResponses.push(tradeEvidence);
          }
          continue;
        }
      }
      const resolvedOrder = terminalOrdersById.get(orderId) ?? terminalOrder;
      if (resolvedOrder === undefined) continue;
      if (!this.orderHasExactAccount(resolvedOrder, accountId)) {
        invalidAttachedEvidence = true;
        continue;
      }
      if (exactStatusAttachmentOrderIds.has(orderId)) {
        const matchingNodes = request.nodes.filter((node) =>
          this.exactStatusTicketMatchesGraphNode(request, node, resolvedOrder)
        );
        const [matchingNode] = matchingNodes;
        if (matchingNodes.length !== 1 || matchingNode === undefined) {
          invalidAttachedEvidence = true;
          continue;
        }
        const existing = byNode.get(matchingNode.memberId);
        if (existing !== undefined) existing.push(resolvedOrder);
        continue;
      }
      for (const node of request.nodes) {
        if (this.terminalOrderMatchesGraphNode(request, node, resolvedOrder)) {
          const existing = byNode.get(node.memberId);
          if (existing !== undefined) existing.push(resolvedOrder);
        }
      }
    }
    return {
      byNode,
      linkedOrders,
      observedResponses,
      invalidAttachedEvidence,
      terminalSnapshotLookupFailed,
    };
  }

  private recoveryGraphOrderIsAttached(
    request: DerivativeOrderGraphRequest,
    order: IbkrLiveOrder
  ): boolean {
    return this.recoveryGraphAttachmentKey(request, order) !== null;
  }

  private orderHasRecoveryAttachmentEvidence(order: IbkrLiveOrder): boolean {
    return [
      order.cOID,
      order.order_ref,
      order.parentId,
      order.parent_id,
      order.parentClientOrderId,
      order.parent_order_ref,
    ].some((value) => value !== undefined);
  }

  private recoveryGraphOrderMayBeAttached(
    request: DerivativeOrderGraphRequest,
    order: IbkrLiveOrder
  ): boolean {
    const graphClientOrderIds = this.graphClientOrderIds(request);
    return [
      order.cOID,
      order.order_ref,
      order.parentId,
      order.parent_id,
      order.parentClientOrderId,
      order.parent_order_ref,
    ].some(
      (value) =>
        (typeof value === "string" || typeof value === "number") &&
        graphClientOrderIds.has(String(value).trim())
    );
  }

  /**
   * IBKR echoes an attached child's `parentId` as the parent's own broker-assigned order ID, not
   * as the client order ID the graph was submitted with, and it echoes it as a number. Both are
   * evidence of the same attachment, so this rewrites such an echo back to the parent member's
   * client order ID before any identity comparison, using only orders observed in the same
   * snapshot.
   *
   * Nothing is inferred: a broker order ID is translated only when exactly one observed order of
   * this graph carries it, and every other alias is left untouched, so an unexplained parent still
   * fails closed.
   */
  private resolveGraphParentAliases(
    request: DerivativeOrderGraphRequest,
    orders: readonly IbkrLiveOrder[]
  ): IbkrLiveOrder[] {
    const graphClientOrderIds = this.graphClientOrderIds(request);
    const memberClientOrderIdByOrderId = new Map<string, string | null>();
    for (const order of orders) {
      const identity = this.consistentStringAliases(order.cOID, order.order_ref);
      if (!identity.valid || identity.value === undefined) continue;
      if (!graphClientOrderIds.has(identity.value)) continue;
      const orderId = this.recoveryOrderId(order);
      if (orderId === undefined) continue;
      const existing = memberClientOrderIdByOrderId.get(orderId);
      memberClientOrderIdByOrderId.set(
        orderId,
        existing === undefined || existing === identity.value ? identity.value : null
      );
    }
    if (memberClientOrderIdByOrderId.size === 0) return [...orders];
    const translate = (value: unknown): unknown => {
      if (typeof value !== "string" && typeof value !== "number") return value;
      return memberClientOrderIdByOrderId.get(String(value).trim()) ?? value;
    };
    return orders.map((order) => {
      const aliases = [
        order.parentId,
        order.parent_id,
        order.parentClientOrderId,
        order.parent_order_ref,
      ];
      if (aliases.every((alias) => alias === undefined)) return order;
      const resolved = { ...order };
      if (order.parentId !== undefined) resolved.parentId = translate(order.parentId) as string;
      if (order.parent_id !== undefined) resolved.parent_id = translate(order.parent_id) as string;
      if (order.parentClientOrderId !== undefined) {
        resolved.parentClientOrderId = translate(order.parentClientOrderId) as string;
      }
      if (order.parent_order_ref !== undefined) {
        resolved.parent_order_ref = translate(order.parent_order_ref) as string;
      }
      return resolved;
    });
  }

  private resolveFlattenedGraphParentAliases(
    request: DerivativeOrderGraphRequest,
    flattened: { order: IbkrLiveOrder; nestedParent: IbkrLiveOrder | null }[] | null
  ): { order: IbkrLiveOrder; nestedParent: IbkrLiveOrder | null }[] | null {
    if (flattened === null) return null;
    const resolved = this.resolveGraphParentAliases(
      request,
      flattened.map(({ order }) => order)
    );
    return flattened.map((entry, index) => ({
      order: resolved[index] ?? entry.order,
      nestedParent: entry.nestedParent,
    }));
  }

  private recoveryGraphAttachmentKey(
    request: DerivativeOrderGraphRequest,
    order: IbkrLiveOrder
  ): string | null {
    const parentIdentity = this.consistentStringAliases(
      order.parentId,
      order.parent_id,
      order.parentClientOrderId,
      order.parent_order_ref
    );
    const clientIdentity = this.consistentStringAliases(order.cOID, order.order_ref);
    if (!parentIdentity.valid || !clientIdentity.valid) return null;
    const clientOrderId = clientIdentity.value;
    if (clientOrderId === request.rootClientOrderId && parentIdentity.value === undefined) {
      return "root";
    }
    if (
      parentIdentity.value !== undefined &&
      this.graphClientOrderIds(request).has(parentIdentity.value)
    ) {
      return `parent:${parentIdentity.value}`;
    }
    return null;
  }

  private terminalOrderTicketConflicts(first: IbkrLiveOrder, second: IbkrLiveOrder): boolean {
    const firstTicket = this.terminalOrderTicketFingerprint(first);
    const secondTicket = this.terminalOrderTicketFingerprint(second);
    return Object.keys(firstTicket).some(
      (field) => field in secondTicket && firstTicket[field] !== secondTicket[field]
    );
  }

  private terminalOrderTicketIsValid(order: IbkrLiveOrder): boolean {
    return !Object.values(this.terminalOrderTicketFingerprint(order)).includes(
      "__MALFORMED_TERMINAL_TICKET_FIELD__"
    );
  }

  private exactComboLegs(conidex: unknown): readonly { conid: number; ratio: number }[] | null {
    if (typeof conidex !== "string") return null;
    const sections = conidex.split(";;;");
    const encoded = sections.length === 2 ? sections[1] : undefined;
    if (!encoded) return null;
    const rawLegs = encoded.split(",");
    if (
      rawLegs.some((rawLeg) => {
        const values = rawLeg.split("/");
        if (values.length !== 2) return true;
        const conid = Number(values[0]);
        const ratio = Number(values[1]);
        return (
          !Number.isSafeInteger(conid) || conid <= 0 || !Number.isSafeInteger(ratio) || ratio === 0
        );
      })
    ) {
      return null;
    }
    const legs = this.parseComboLegs(conidex);
    return legs.length === rawLegs.length ? legs : null;
  }

  private comboLegFingerprint(legs: readonly { conid: number; ratio: number }[]): string {
    return JSON.stringify(
      [...legs].sort((left, right) => left.conid - right.conid || left.ratio - right.ratio)
    );
  }

  private terminalOrderTicketFingerprint(order: IbkrLiveOrder): Record<string, string | boolean> {
    const ticket: Record<string, string | boolean> = {};
    const malformed = "__MALFORMED_TERMINAL_TICKET_FIELD__";
    const addAliases = (
      field: string,
      values: readonly unknown[],
      normalize: (value: unknown) => string | boolean | undefined
    ) => {
      // An empty string is IBKR's "this field does not apply to this order", not a value that
      // conflicts with its own aliases: a stop order carries `price: ""` next to a real
      // `stop_price`. Treating it as provided marked every such ticket malformed.
      const provided = values.filter(
        (value) => value !== undefined && !(typeof value === "string" && value.trim() === "")
      );
      if (provided.length === 0) return;
      const normalized = provided.map(normalize);
      const [first] = normalized;
      ticket[field] =
        first !== undefined && normalized.every((value) => value === first) ? first : malformed;
    };
    const normalizeNumber = (value: unknown): string | undefined => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
      if (typeof value === "string" && value.trim() !== "") {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? String(numeric) : undefined;
      }
      return undefined;
    };

    addAliases("conid", [order.conid], normalizeNumber);
    if (order.conidex !== undefined) {
      if (typeof order.conidex !== "string") {
        ticket["conidex"] = malformed;
      } else if (order.conidex.includes(";;;")) {
        const legs = this.exactComboLegs(order.conidex);
        ticket["conidex"] = legs === null ? malformed : this.comboLegFingerprint(legs);
      } else {
        const scalarConid = normalizeNumber(order.conidex);
        const orderConid = normalizeNumber(order.conid);
        ticket["conidex"] =
          scalarConid !== undefined && (orderConid === undefined || orderConid === scalarConid)
            ? `single:${scalarConid}`
            : malformed;
      }
    }
    addAliases("orderType", [order.order_type, order.orderType], (value) =>
      typeof value === "string" ? this.normalizeOrderType(value) : undefined
    );
    addAliases("side", [order.side], (value) =>
      typeof value === "string" ? this.normalizeOrderSide(value) : undefined
    );
    // `size` is IBKR's remaining size, not an alias of the ticket quantity: a filled order reports
    // `size: "0.0"` next to `total_size: "1.0"`. Comparing the two marked every filled ticket
    // malformed, which is exactly the evidence recovery needs most.
    addAliases("quantity", [order.total_size, order.totalSize], normalizeNumber);
    addAliases(
      "price",
      [
        order.limitPrice,
        order.limit_price,
        order.stopPrice,
        order.stop_price,
        order.auxPrice,
        order.aux_price,
        order.price,
      ],
      normalizeNumber
    );
    addAliases("tif", [order.tif, order.timeInForce], (value) => this.canonicalTimeInForce(value));
    addAliases("outsideRTH", [order.outsideRTH, order.outside_rth], (value) =>
      typeof value === "boolean" ? value : undefined
    );
    return ticket;
  }

  private orderHasExactAccount(order: IbkrLiveOrder, accountId: string): boolean {
    const accounts: readonly unknown[] = [order.account, order.acct];
    const provided = accounts.filter((account) => account !== undefined);
    return (
      provided.length > 0 &&
      provided.every((account) => typeof account === "string" && account === accountId)
    );
  }

  private orderMatchesExactRecoveryIdentity(
    order: IbkrLiveOrder,
    accountId: string,
    orderId: string
  ): boolean {
    return this.orderHasExactAccount(order, accountId) && this.recoveryOrderId(order) === orderId;
  }

  private orderHasValidRecoveryStatus(order: IbkrLiveOrder): boolean {
    const provided = [order.order_status, order.orderStatus, order.status].filter(
      (status) => status !== undefined
    );
    if (provided.length === 0) return true;
    const normalized = provided.map((status) => this.canonicalIbkrOrderStatus(status));
    const [first] = normalized;
    return first !== undefined && normalized.every((status) => status === first);
  }

  private assignRecoveryGraphCandidates(
    unresolvedNodes: readonly DerivativeOrderGraphNode[],
    terminalCandidates: Map<string, IbkrLiveOrder[]>,
    usedOrderIds: Set<string>
  ): Map<string, IbkrLiveOrder> {
    const assignments = new Map<string, IbkrLiveOrder>();
    const uniqueCandidates = new Map<
      string,
      { node: DerivativeOrderGraphNode; order: IbkrLiveOrder }[]
    >();
    for (const node of unresolvedNodes) {
      const candidates = terminalCandidates.get(node.memberId) ?? [];
      if (candidates.length !== 1) continue;
      const order = candidates[0];
      if (order === undefined) continue;
      const orderId = this.recoveryOrderId(order);
      if (orderId === undefined || usedOrderIds.has(orderId)) continue;
      const owners = uniqueCandidates.get(orderId) ?? [];
      owners.push({ node, order });
      uniqueCandidates.set(orderId, owners);
    }
    for (const owners of uniqueCandidates.values()) {
      const owner = owners[0];
      if (owners.length !== 1 || owner === undefined) continue;
      assignments.set(owner.node.memberId, owner.order);
    }
    return assignments;
  }

  async acknowledgeOrderWarning(input: {
    accountId: string;
    replyId: string;
    confirmed: true;
  }): Promise<DerivativeOrderSubmissionResult> {
    this.assertOpen();
    const confirmed: unknown = input.confirmed;
    if (confirmed !== true) throw new Error("Order warning confirmation must be true");
    if (!input.accountId.trim()) throw new Error("An exact account ID is required");
    if (!input.replyId.trim()) throw new Error("An exact warning reply ID is required");
    return this.withTradingMutation(
      input.accountId,
      "IBKR brokerage session is not safely authenticated for warning acknowledgement",
      async () => {
        const response = await this.singleAttemptRequest<
          IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[]
        >({
          path: `iserver/reply/${encodeURIComponent(input.replyId)}`,
          method: "POST",
          data: { confirmed: true },
        });
        return this.normalizeOrderSubmission(response, null);
      }
    );
  }

  async acknowledgeContingentOrderWarning(input: {
    continuation: { accountId: string; replyId: string; parentClientOrderId: string };
    confirmed: true;
  }): Promise<DerivativeMultiOrderResult> {
    this.assertOpen();
    const confirmed: unknown = input.confirmed;
    if (confirmed !== true) {
      throw new Error("Order warning confirmation must be true");
    }
    if (!input.continuation.accountId.trim()) {
      throw new Error("An exact account ID is required");
    }
    if (!input.continuation.replyId.trim()) {
      throw new Error("An exact warning reply ID is required");
    }
    if (!input.continuation.parentClientOrderId.trim()) {
      throw new Error("An exact parent client order ID is required");
    }
    return this.withTradingMutation(
      input.continuation.accountId,
      "IBKR brokerage session is not safely authenticated for warning acknowledgement",
      async () => {
        const response = await this.singleAttemptRequest<
          IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[]
        >({
          path: `iserver/reply/${encodeURIComponent(input.continuation.replyId)}`,
          method: "POST",
          data: { confirmed: true },
        });
        return this.normalizeMultiOrderSubmission(
          response,
          input.continuation.parentClientOrderId,
          input.continuation.accountId
        );
      }
    );
  }

  async getDerivativeOrderStatus(
    accountId: string,
    orderId: string
  ): Promise<DerivativeOrderLifecycle> {
    this.assertOpen();
    if (!accountId.trim() || !orderId.trim()) {
      throw new Error("Exact account and order IDs are required");
    }
    return this.withAccountCriticalSection(async () => {
      await this.prepareBrokerageAccount(accountId);
      return this.getDerivativeOrderStatusPrepared(accountId, orderId);
    });
  }

  private async getDerivativeOrderStatusPrepared(
    accountId: string,
    orderId: string
  ): Promise<DerivativeOrderLifecycle> {
    const order = await this.req<IbkrLiveOrder>({
      path: `iserver/account/order/status/${encodeURIComponent(orderId)}`,
    });
    if (!this.orderHasExactAccount(order, accountId)) {
      throw new Error(`IBKR order ${orderId} does not belong to the requested account`);
    }
    if (this.recoveryOrderId(order) !== orderId) {
      throw new Error(`IBKR response does not match the requested order ${orderId}`);
    }
    const lifecycle = this.normalizeDerivativeOrderLifecycle(accountId, orderId, order);
    if (lifecycle.status === "UNKNOWN") {
      throw new Error(`IBKR order ${orderId} returned an unrecognized status`);
    }
    return lifecycle;
  }

  async findDerivativeOrder(input: DerivativeOrderLookup): Promise<DerivativeOrderLifecycle> {
    this.assertOpen();
    if (!input.accountId.trim()) throw new Error("An exact account ID is required");
    const identity = input.orderId ?? input.clientOrderId;
    if (!identity.trim()) throw new Error("An exact broker or client order ID is required");
    if (input.orderId !== undefined) {
      return this.getDerivativeOrderStatus(input.accountId, input.orderId);
    }
    return this.withAccountCriticalSection(async () => {
      await this.prepareBrokerageAccount(input.accountId);
      const response = await this.req<IbkrLiveOrdersResponse>({
        path: "iserver/account/orders",
        params: { accountId: input.accountId },
      });
      const order = response.orders?.find((candidate) => {
        if (!this.orderBelongsToAccount(candidate, input.accountId)) return false;
        return (candidate.cOID ?? candidate.order_ref) === input.clientOrderId;
      });
      if (order === undefined) throw new Error(`IBKR order ${identity} was not found`);
      const orderId = order.order_id ?? order.orderId;
      if (orderId === undefined) {
        throw new Error(`IBKR order ${identity} did not include a broker order ID`);
      }
      return this.getDerivativeOrderStatusPrepared(input.accountId, String(orderId));
    });
  }

  async listActiveDerivativeOrders(accountId: string): Promise<ActiveDerivativeOrder[]> {
    this.assertOpen();
    if (!accountId.trim()) throw new Error("An exact account ID is required");
    return this.withAccountCriticalSection(async () => {
      await this.prepareBrokerageAccount(accountId);
      const response = await this.req<IbkrLiveOrdersResponse>({
        path: "iserver/account/orders",
        params: { accountId },
      });
      const flattened = this.flattenCompleteOrderSnapshot(response);
      if (flattened === null) {
        throw new Error("IBKR active-order snapshot is incomplete");
      }
      const invalidAccountEvidence = flattened.find(({ order }) => {
        const returnedAccounts: readonly unknown[] = [order.account, order.acct];
        const providedAccounts = returnedAccounts.filter((value) => value !== undefined);
        return (
          providedAccounts.length === 0 ||
          providedAccounts.some(
            (returnedAccount) =>
              typeof returnedAccount !== "string" || returnedAccount !== accountId
          )
        );
      });
      if (invalidAccountEvidence !== undefined) {
        throw new Error("IBKR active-order response did not provide unambiguous account identity");
      }

      const normalized = flattened.map(({ order, nestedParent }) =>
        this.normalizeActiveDerivativeOrder(accountId, order, nestedParent)
      );
      const byOrderId = new Map<string, ActiveDerivativeOrder[]>();
      const byClientId = new Map<string, ActiveDerivativeOrder[]>();
      for (const order of normalized) {
        if (order.orderId !== null) {
          const members = byOrderId.get(order.orderId) ?? [];
          members.push(order);
          byOrderId.set(order.orderId, members);
        }
        if (order.clientOrderId !== null) {
          const members = byClientId.get(order.clientOrderId) ?? [];
          members.push(order);
          byClientId.set(order.clientOrderId, members);
        }
      }
      for (const order of normalized) {
        if (order.orderId !== null && (byOrderId.get(order.orderId)?.length ?? 0) > 1) {
          this.addOrderUncertainty(order, "DUPLICATE_MEMBER");
        }
        const parentIdentity = order.parentOrderId ?? order.parentClientOrderId;
        if (parentIdentity === null) continue;
        const brokerMatches = byOrderId.get(parentIdentity) ?? [];
        const clientMatches = byClientId.get(parentIdentity) ?? [];
        const matches = new Set([...brokerMatches, ...clientMatches]);
        if (matches.size === 0) this.addOrderUncertainty(order, "MISSING_PARENT");
        if (matches.size > 1) this.addOrderUncertainty(order, "AMBIGUOUS_PARENT");
      }
      return normalized;
    });
  }

  async getDerivativeExecutions(input: DerivativeExecutionQuery): Promise<DerivativeExecution[]> {
    this.assertOpen();
    if (!input.accountId.trim()) throw new Error("An exact account ID is required");
    if (
      input.days !== undefined &&
      (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > 7)
    ) {
      throw new Error("Execution history days must be an integer from 1 through 7");
    }
    if (input.orderId !== undefined && !input.orderId.trim()) {
      throw new Error("Broker order ID cannot be empty");
    }
    if (input.clientOrderId !== undefined && !input.clientOrderId.trim()) {
      throw new Error("Client order ID cannot be empty");
    }
    return this.withAccountCriticalSection(async () => {
      await this.prepareBrokerageAccount(input.accountId);
      const response = await this.req<IbkrTrade[]>({
        path: "iserver/account/trades",
        ...(input.days === undefined ? {} : { params: { days: input.days } }),
      });
      return response
        .filter((trade) => (trade.account ?? trade.accountCode) === input.accountId)
        .filter((trade) => input.orderId === undefined || String(trade.order_id) === input.orderId)
        .filter(
          (trade) => input.clientOrderId === undefined || trade.order_ref === input.clientOrderId
        )
        .flatMap((trade) => {
          const execution = this.normalizeDerivativeExecution(input.accountId, trade);
          return execution === undefined ? [] : [execution];
        });
    });
  }

  async reconcileDerivativeComboExecution(
    request: DerivativeComboReconciliationRequest
  ): Promise<DerivativeComboReconciliation> {
    this.assertOpen();
    this.validateReconciliationRequest(request);
    const lifecycle = await this.getDerivativeOrderStatus(request.accountId, request.orderId);
    const deadline = this.now() + (request.timeoutMs ?? 30_000);
    const pollMs = request.pollMs ?? 1_000;

    for (;;) {
      const executions = await this.getDerivativeExecutions({
        accountId: request.accountId,
        clientOrderId: request.clientOrderId,
        days: 1,
      });
      const result = this.evaluateDerivativeReconciliation(request, lifecycle, executions);
      if (result.state !== "PENDING") return result;
      if (!this.isTerminalDerivativeStatus(lifecycle.status)) return result;
      if (this.now() >= deadline) {
        return {
          ...result,
          state: "RECOVERY_REQUIRED",
          reason: result.reason ?? "Terminal order is missing expected execution evidence",
        };
      }
      await this.wait(Math.min(pollMs, Math.max(0, deadline - this.now())));
    }
  }

  async cancelDerivativeOrder(
    input: DerivativeOrderCancelRequest
  ): Promise<DerivativeOrderCancellationResult> {
    this.assertOpen();
    if (!input.accountId.trim() || !input.orderId.trim()) {
      throw new Error("Exact account and order IDs are required");
    }
    const cmeOperatorMetadata = this.cmeOperatorMetadata(input.assetClass, input);
    return this.withTradingMutation(
      input.accountId,
      "IBKR brokerage session is not safely authenticated for cancellation",
      async () => {
        const response = await this.singleAttemptRequest<unknown>({
          path: `iserver/account/${input.accountId}/order/${encodeURIComponent(input.orderId)}`,
          method: "DELETE",
          ...(Object.keys(cmeOperatorMetadata).length > 0 ? { params: cmeOperatorMetadata } : {}),
        });
        return this.normalizeOrderCancellation(input, response);
      }
    );
  }

  async getAccountId(): Promise<string> {
    this.assertOpen();
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
    this.assertOpen();
    const accountId = await this.getAccountId();
    const summary = await this.req<IbkrPortfolioSummary>({
      path: `portfolio/${accountId}/summary`,
    });
    const amount = (key: string): number => toNumber(summary[key]?.amount);
    const marginSnapshot = (suffix: "" | "-s" | "-c") => ({
      equityWithLoanValue: toNullableNumber(summary[`equitywithloanvalue${suffix}`]?.amount),
      regTEquity: toNullableNumber(summary[`regtequity${suffix}`]?.amount),
      regTMargin: toNullableNumber(summary[`regtmargin${suffix}`]?.amount),
      initialMarginRequirement: toNullableNumber(summary[`initmarginreq${suffix}`]?.amount),
      maintenanceMarginRequirement: toNullableNumber(summary[`maintmarginreq${suffix}`]?.amount),
      availableFunds: toNullableNumber(summary[`availablefunds${suffix}`]?.amount),
      excessLiquidity: toNullableNumber(summary[`excessliquidity${suffix}`]?.amount),
      cushion: toNullableNumber(summary[`cushion${suffix}`]?.amount),
      sma: toNullableNumber(summary[`sma${suffix}`]?.amount),
      buyingPower: toNullableNumber(summary[`buyingpower${suffix}`]?.amount),
      fullInitialMarginRequirement: toNullableNumber(summary[`fullinitmarginreq${suffix}`]?.amount),
      fullMaintenanceMarginRequirement: toNullableNumber(
        summary[`fullmaintmarginreq${suffix}`]?.amount
      ),
      fullAvailableFunds: toNullableNumber(summary[`fullavailablefunds${suffix}`]?.amount),
      fullExcessLiquidity: toNullableNumber(summary[`fullexcessliquidity${suffix}`]?.amount),
      lookAheadInitialMarginRequirement: toNullableNumber(
        summary[`lookaheadinitmarginreq${suffix}`]?.amount
      ),
      lookAheadMaintenanceMarginRequirement: toNullableNumber(
        summary[`lookaheadmaintmarginreq${suffix}`]?.amount
      ),
      lookAheadAvailableFunds: toNullableNumber(
        summary[`lookaheadavailablefunds${suffix}`]?.amount
      ),
      lookAheadExcessLiquidity: toNullableNumber(
        summary[`lookaheadexcessliquidity${suffix}`]?.amount
      ),
      lookAheadNextChange: toNullableNumber(summary[`lookaheadnextchange${suffix}`]?.amount),
      leverage: toNullableNumber(summary[`leverage${suffix}`]?.amount),
    });
    return {
      netLiquidation: amount("netliquidation"),
      availableFunds: amount("availablefunds"),
      buyingPower: amount("buyingpower"),
      cashBalance: amount("totalcashvalue"),
      margin: {
        total: marginSnapshot(""),
        securities: marginSnapshot("-s"),
        commodities: marginSnapshot("-c"),
      },
    };
  }

  async getPositions(symbol?: string): Promise<BrokerPosition[]> {
    this.assertOpen();
    const accountId = await this.getAccountId();
    const rows = await this.fetchAllPositions(accountId);
    for (const position of rows) {
      if (
        position.conid === undefined ||
        !Number.isSafeInteger(position.conid) ||
        position.conid <= 0
      ) {
        throw new Error(
          `IBKR returned an invalid position contract id for ${position.contractDesc ?? "-"}`
        );
      }
    }
    const dayPnl = await this.fetchDayPnl(rows.map((position) => String(position.conid)));

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
    const contractDescription = p.contractDesc ?? String(p.conid ?? "-");
    const symbol =
      assetClass === "OPT"
        ? (extractOsiPositionSymbol(contractDescription) ?? contractDescription)
        : contractDescription;
    if (p.conid === undefined || !Number.isSafeInteger(p.conid) || p.conid <= 0) {
      throw new Error(`IBKR returned an invalid position contract id for ${symbol}`);
    }
    return {
      brokerId: String(p.conid),
      symbol,
      assetType: ASSET_CLASS_LABELS[assetClass] ?? (assetClass || "-"),
      longQuantity: qty > 0 ? qty : 0,
      shortQuantity: qty < 0 ? Math.abs(qty) : 0,
      averagePrice: toNumber(p.avgPrice),
      ...(p.multiplier === undefined ? {} : { multiplier: p.multiplier }),
      marketPrice: toNumber(p.mktPrice),
      marketValue: toNumber(p.mktValue),
      currentDayProfitLoss: dayPnl.get(p.conid) ?? 0,
      openProfitLoss: toNumber(p.unrealizedPnl),
    };
  }

  async getQuotes(
    requests: readonly BrokerQuoteRequest[],
    options: BrokerQuoteOptions = {}
  ): Promise<Record<string, BrokerQuote>> {
    this.assertOpen();
    const unique = new Map<string, BrokerQuoteRequest>();
    for (const request of requests) {
      if (!request.symbol.trim()) throw new Error("A quote request symbol is required");
      const existing = unique.get(request.symbol);
      if (existing !== undefined && existing.brokerId !== request.brokerId) {
        throw new Error(`Conflicting IBKR broker contract ids for ${request.symbol}`);
      }
      unique.set(request.symbol, request);
    }

    const contracts = await Promise.all(
      [...unique.values()].map(async (request): Promise<QuoteContract | undefined> => {
        if (request.brokerId === undefined) return this.resolveQuoteContract(request.symbol);
        if (!/^[1-9]\d*$/.test(request.brokerId)) {
          throw new Error(`Invalid IBKR broker contract id: ${request.brokerId}`);
        }
        const conid = Number(request.brokerId);
        if (!Number.isSafeInteger(conid) || conid <= 0) {
          throw new Error(`Invalid IBKR broker contract id: ${request.brokerId}`);
        }
        return {
          requestedSymbol: request.symbol,
          symbol: request.symbol,
          conid,
        };
      })
    );
    return this.fetchQuotes(
      contracts.filter((contract): contract is QuoteContract => contract !== undefined),
      options.includeHistory ?? true
    );
  }

  private async fetchQuotes(
    contracts: readonly QuoteContract[],
    includeHistory: boolean
  ): Promise<Record<string, BrokerQuote>> {
    if (!contracts.length) return {};

    const conids = contracts.map((contract) => contract.conid).join(",");
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
    const histories = includeHistory
      ? await Promise.all(contracts.map((contract) => this.fetchQuoteHistory(contract.conid)))
      : contracts.map(() => undefined);
    const quotes: Record<string, BrokerQuote> = {};

    for (const [index, contract] of contracts.entries()) {
      const snapshot = snapshotByConid.get(contract.conid);
      if (snapshot === undefined) continue;
      const history = histories[index];
      const quote = this.normalizeQuote(contract, snapshot, history);
      quotes[contract.requestedSymbol] = quote;
    }

    return quotes;
  }

  /** Resolve equity/ETF symbols to IBKR contracts via `trsrv/stocks`. */
  async searchInstruments(
    symbol: string,
    projection: BrokerInstrumentSearchProjection = "symbol-search"
  ): Promise<BrokerInstrument[]> {
    this.assertOpen();
    if (projection !== "symbol-search" && projection !== "search") {
      throw new Error(
        `IBKR search currently supports only symbol-search/search projections (got '${projection}').`
      );
    }
    const query = symbol.trim().toUpperCase();
    if (!query) return [];

    const response = await this.req<IbkrStocksResponse>({
      path: "trsrv/stocks",
      params: { symbols: query },
    });

    return (response[query] ?? []).flatMap((listing) => this.normalizeStockListing(query, listing));
  }

  async fetchTransactionHistory(
    startDate: Date,
    endDate: Date
  ): Promise<BrokerTransactionHistory[]> {
    this.assertOpen();
    const accountId = await this.getAccountId();
    const rows = await this.fetchAllPositions(accountId);
    const positionsByConid = new Map(
      rows
        .filter(
          (position): position is IbkrPosition & { conid: number } => position.conid !== undefined
        )
        .map((position) => [position.conid, position])
    );
    const transactionsByKey = new Map<string, BrokerTransaction>();
    const days = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / DAY_MS) + 1);

    for (const conid of positionsByConid.keys()) {
      const response = await this.req<IbkrTransactionsResponse>({
        path: "pa/transactions",
        method: "POST",
        data: {
          acctIds: [accountId],
          conids: [conid],
          currency: process.env["IBKR_TRANSACTION_CURRENCY"] ?? "USD",
          days,
        },
      });

      for (const transaction of response.transactions ?? []) {
        const normalized = this.normalizeTransaction(transaction, positionsByConid);
        const time = new Date(normalized.time).getTime();
        if (time < startDate.getTime() || time > endDate.getTime()) continue;
        transactionsByKey.set(this.transactionKey(normalized), normalized);
      }
    }

    return [{ accountNumber: accountId, transactions: [...transactionsByKey.values()] }];
  }

  async fetchOrders(options: BrokerOrdersOptions): Promise<BrokerAccountOrders[]> {
    this.assertOpen();
    const accountId = await this.getAccountId();
    return this.withAccountCriticalSection(async () => {
      await this.prepareBrokerageAccount(accountId);

      const params: Record<string, string | boolean> = {};
      if (options.status && options.status.toUpperCase() !== "WORKING") {
        params["filters"] = this.ibkrStatusFilter(options.status);
      }

      const response = await this.req<IbkrLiveOrdersResponse>({
        path: "iserver/account/orders",
        params,
      });

      let orders = (response.orders ?? [])
        .filter((order) => this.orderBelongsToAccount(order, accountId))
        .map((order) => this.normalizeOrder(order))
        .filter((order) => this.orderMatchesStatus(order, options.status))
        .filter((order) =>
          this.orderInDateRange(order, options.fromEnteredTime, options.toEnteredTime)
        )
        .sort((left, right) => this.orderTimeMs(right) - this.orderTimeMs(left));

      if (options.maxResults !== undefined) orders = orders.slice(0, options.maxResults);
      return [{ accountNumber: accountId, orders }];
    });
  }

  private validateComboPreview(request: DerivativeComboPreviewRequest): void {
    if (!request.accountId.trim()) throw new Error("An explicit IBKR account ID is required");
    if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0) {
      throw new Error("Combo quantity must be a positive integer");
    }
    const orderType: unknown = request.orderType;
    if (orderType !== "LMT" && orderType !== "STP") {
      throw new Error("Combo order type must be LMT or STP");
    }
    if (request.orderType === "LMT" && (!Number.isFinite(request.limit) || request.limit <= 0)) {
      throw new Error("Combo limit must be a positive number");
    }
    if (
      request.orderType === "STP" &&
      (!Number.isFinite(request.stopPrice) || request.stopPrice <= 0)
    ) {
      throw new Error("Combo stop order requires a positive stop price");
    }
    const [first, second] = request.legs;
    if (first.ratio === second.ratio) throw new Error("Combo requires one long and one short leg");
    if (first.contract.conid === second.contract.conid) {
      throw new Error("Combo legs must reference distinct contracts");
    }
    for (const { contract } of request.legs) {
      if (!Number.isSafeInteger(contract.conid) || contract.conid <= 0) {
        throw new Error("Combo leg has an invalid IBKR conid");
      }
    }
    const identityFields: (keyof DerivativeContract)[] = [
      "assetClass",
      "underlying",
      "expiration",
      "right",
      "tradingClass",
      "exchange",
      "multiplier",
    ];
    for (const field of identityFields) {
      if (first.contract[field] !== second.contract[field]) {
        throw new Error(`Combo legs differ on ${field}`);
      }
    }
  }

  private validateOrderGraph(request: DerivativeOrderGraphRequest): void {
    if (!request.accountId.trim()) throw new Error("An explicit IBKR account ID is required");
    if (!request.rootClientOrderId.trim() || request.rootClientOrderId.length > 48) {
      throw new Error("Root client order ID must contain 1 to 48 characters");
    }
    if (request.nodes.length < 1 || request.nodes.length > 8) {
      throw new Error("Derivative order graphs require 1 to 8 members");
    }
    const seen = new Set<string>();
    let roots = 0;
    for (const node of request.nodes) {
      if (
        !node.memberId.trim() ||
        node.memberId.length > 15 ||
        !/^[A-Za-z0-9_-]+$/.test(node.memberId)
      ) {
        throw new Error("Graph member IDs must contain 1 to 15 safe characters");
      }
      if (seen.has(node.memberId)) throw new Error("Graph member IDs must be unique");
      if (node.accountId !== request.accountId)
        throw new Error("Every graph member must target the graph account");
      if (node.parentMemberId === undefined) roots += 1;
      else if (!seen.has(node.parentMemberId))
        throw new Error("Graph parents must precede their children");
      if ("legs" in node) {
        this.validateComboPreview(node);
      } else {
        this.validateGraphSingleNode(node);
      }
      seen.add(node.memberId);
    }
    if (roots !== 1 || request.nodes[0]?.parentMemberId !== undefined) {
      throw new Error("Derivative order graphs require exactly one root as the first member");
    }
  }

  private validateGraphSingleNode(
    node: Exclude<DerivativeOrderGraphNode, { legs: unknown }>
  ): void {
    const orderType: unknown = node.orderType;
    if (orderType !== "LMT" && orderType !== "STP" && orderType !== "MKT") {
      throw new Error("Graph single order type must be LMT, STP, or MKT");
    }
    if (!Number.isSafeInteger(node.quantity) || node.quantity <= 0)
      throw new Error("Order quantity must be a positive integer");
    if (!Number.isSafeInteger(node.contract.conid) || node.contract.conid <= 0)
      throw new Error("Order contract has an invalid IBKR conid");
    if (node.orderType === "LMT" && (!Number.isFinite(node.limit) || node.limit <= 0))
      throw new Error("LIMIT order requires a positive limit price");
    if (node.orderType === "STP" && (!Number.isFinite(node.stopPrice) || node.stopPrice <= 0))
      throw new Error("STOP order requires a positive stop price");
    this.cmeOperatorMetadata(node.contract.assetClass, node);
  }

  /**
   * IBKR's order snapshot reports a DAY order's time in force as `CLOSE` ("good until the close"),
   * while the order it was submitted with, and `iserver/account/order/status`, both say `DAY`.
   * They are the same instruction, so recovery must not read the two spellings as different
   * orders. Every other value is passed through unchanged and still has to match exactly.
   */
  private canonicalTimeInForce(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const upper = value.trim().toUpperCase();
    if (upper === "") return undefined;
    return upper === "CLOSE" ? "DAY" : upper;
  }

  /**
   * A stop price reaches this client under four spellings. IBKR sends `stop_price` and `auxPrice`
   * on the order snapshot, `stopPrice` on some payloads, and an empty `price` string for the same
   * order - an empty string means "not applicable here", never zero.
   */
  private observedStopPrice(order: IbkrLiveOrder): number | undefined {
    return this.firstNumber(order.stopPrice, order.stop_price, order.auxPrice, order.aux_price);
  }

  private graphClientOrderId(
    request: DerivativeOrderGraphRequest,
    node: DerivativeOrderGraphNode
  ): string {
    return node.parentMemberId === undefined
      ? request.rootClientOrderId
      : `${request.rootClientOrderId}:${node.memberId}`;
  }

  private graphClientOrderIds(request: DerivativeOrderGraphRequest): Set<string> {
    return new Set(request.nodes.map((node) => this.graphClientOrderId(request, node)));
  }

  private graphParentClientOrderId(
    request: DerivativeOrderGraphRequest,
    node: DerivativeOrderGraphNode
  ): string | undefined {
    if (node.parentMemberId === undefined) return undefined;
    const parent = request.nodes.find(({ memberId }) => memberId === node.parentMemberId);
    if (parent === undefined) throw new Error("Graph parent evidence was lost after validation");
    return this.graphClientOrderId(request, parent);
  }

  private graphOrderTicket(
    request: DerivativeOrderGraphRequest,
    node: DerivativeOrderGraphNode
  ): Record<string, unknown> {
    const parentClientOrderId = this.graphParentClientOrderId(request, node);
    const identity: Record<string, string> = {
      cOID: this.graphClientOrderId(request, node),
      ...(parentClientOrderId === undefined ? {} : { parentId: parentClientOrderId }),
    };
    if ("legs" in node)
      return {
        ...this.comboOrderTicket(node),
        ...identity,
        ...this.cmeOperatorMetadata(node.legs[0].contract.assetClass, node),
      };
    return {
      acctId: node.accountId,
      conid: node.contract.conid,
      orderType: node.orderType,
      side: node.side,
      ...(node.orderType === "LMT"
        ? { price: node.limit }
        : node.orderType === "STP"
          ? { price: node.stopPrice }
          : {}),
      tif: node.tif,
      quantity: node.quantity,
      outsideRTH: node.session === "OVERNIGHT",
      ...identity,
      ...this.cmeOperatorMetadata(node.contract.assetClass, node),
    };
  }

  private liveOrderMatchesGraphNode(
    request: DerivativeOrderGraphRequest,
    node: DerivativeOrderGraphNode,
    order: IbkrLiveOrder
  ): boolean {
    const clientIdentity = this.consistentStringAliases(order.cOID, order.order_ref);
    if (!clientIdentity.valid) return false;
    const expectedClientOrderId = this.graphClientOrderId(request, node);
    if (clientIdentity.value !== undefined && clientIdentity.value !== expectedClientOrderId) {
      return false;
    }
    const parentIdentity = this.consistentStringAliases(
      order.parentId,
      order.parent_id,
      order.parentClientOrderId,
      order.parent_order_ref
    );
    if (!parentIdentity.valid) return false;
    const expectedParentClientOrderId = this.graphParentClientOrderId(request, node);
    if (expectedParentClientOrderId === undefined) {
      if (clientIdentity.value !== expectedClientOrderId) return false;
      if (parentIdentity.value !== undefined) return false;
    } else if (parentIdentity.value !== expectedParentClientOrderId) return false;
    if ("legs" in node) {
      const liveLegs = this.exactComboLegs(order.conidex);
      if (liveLegs === null) return false;
      const liveLegFingerprint = this.comboLegFingerprint(liveLegs);
      const requestedLegFingerprint = this.comboLegFingerprint(
        node.legs.map(({ contract, ratio }) => ({ conid: contract.conid, ratio }))
      );
      const orderType = this.normalizeOrderType(order.order_type ?? order.orderType);
      const side = this.normalizeOrderSide(order.side);
      const quantity = this.firstPositiveNumber(order.total_size, order.totalSize, order.size);
      const price =
        node.orderType === "LMT"
          ? this.firstNumber(order.limitPrice, order.limit_price, order.price)
          : this.observedStopPrice(order);
      const amount = node.orderType === "LMT" ? node.limit : node.stopPrice;
      const expectedPrice = node.priceEffect === "CREDIT" ? -amount : amount;
      const outsideRth = order.outsideRTH ?? order.outside_rth;
      const tif = this.canonicalTimeInForce(order.tif ?? order.timeInForce);
      return (
        liveLegFingerprint === requestedLegFingerprint &&
        orderType === this.normalizeOrderType(node.orderType) &&
        side === "BUY" &&
        quantity === node.quantity &&
        price === expectedPrice &&
        (tif === undefined || tif === node.tif) &&
        (outsideRth === undefined || outsideRth === (node.session === "OVERNIGHT"))
      );
    }
    const orderType = this.normalizeOrderType(order.order_type ?? order.orderType);
    const expectedOrderType = this.normalizeOrderType(node.orderType);
    const side = this.normalizeOrderSide(order.side);
    const quantity = this.firstPositiveNumber(order.total_size, order.totalSize, order.size);
    const price =
      node.orderType === "LMT"
        ? this.firstNumber(order.limitPrice, order.limit_price, order.price)
        : node.orderType === "STP"
          ? this.observedStopPrice(order)
          : undefined;
    const expectedPrice =
      node.orderType === "LMT" ? node.limit : node.orderType === "STP" ? node.stopPrice : undefined;
    const outsideRth = order.outsideRTH ?? order.outside_rth;
    const tif = this.canonicalTimeInForce(order.tif ?? order.timeInForce);
    return (
      order.conid === node.contract.conid &&
      orderType === expectedOrderType &&
      side === node.side &&
      quantity === node.quantity &&
      price === expectedPrice &&
      (tif === undefined || tif === node.tif) &&
      (outsideRth === undefined || outsideRth === (node.session === "OVERNIGHT"))
    );
  }

  private recoveryOrderMatchesGraphNode(
    request: DerivativeOrderGraphRequest,
    node: DerivativeOrderGraphNode,
    order: IbkrLiveOrder
  ): boolean {
    try {
      return this.liveOrderMatchesGraphNode(request, node, order);
    } catch {
      return false;
    }
  }

  private exactStatusTicketMatchesGraphNode(
    request: DerivativeOrderGraphRequest,
    node: DerivativeOrderGraphNode,
    order: IbkrLiveOrder
  ): boolean {
    if (this.orderHasRecoveryAttachmentEvidence(order)) return false;
    const parentClientOrderId = this.graphParentClientOrderId(request, node);
    const orderWithExpectedAttachment: IbkrLiveOrder =
      parentClientOrderId === undefined
        ? { ...order, cOID: this.graphClientOrderId(request, node) }
        : { ...order, parentId: parentClientOrderId };
    return this.terminalOrderMatchesGraphNode(request, node, orderWithExpectedAttachment);
  }

  private terminalOrderMatchesGraphNode(
    request: DerivativeOrderGraphRequest,
    node: DerivativeOrderGraphNode,
    order: IbkrLiveOrder
  ): boolean {
    try {
      const tif = order.tif ?? order.timeInForce;
      const status = order.order_status ?? order.orderStatus ?? order.status;
      // IBKR never reports `outsideRTH` on the order snapshot, so requiring it here made terminal
      // evidence unusable for every real order. Identity still rests on the client order ID, the
      // conidex, the order type, the side, the quantity, the price, and the time in force, all of
      // which `recoveryOrderMatchesGraphNode` compares exactly below.
      if (typeof tif !== "string" || typeof status !== "string") {
        return false;
      }
      return this.recoveryOrderMatchesGraphNode(request, node, order);
    } catch {
      return false;
    }
  }

  private validateSingleOrder(request: DerivativeSingleOrderRequest): void {
    this.validateSingleOrderFields(request);
    const identityFields = request as unknown as {
      clientOrderId?: unknown;
      parentId?: unknown;
    };
    const hasClientOrderId = "clientOrderId" in identityFields;
    const hasParentId = "parentId" in identityFields;
    if (hasClientOrderId && typeof identityFields.clientOrderId !== "string") {
      throw new Error("Client order ID must be a string");
    }
    if (hasParentId && typeof identityFields.parentId !== "string") {
      throw new Error("Parent order ID must be a string");
    }
    const clientOrderId = hasClientOrderId ? (identityFields.clientOrderId as string) : undefined;
    const parentId = hasParentId ? (identityFields.parentId as string) : undefined;
    if (clientOrderId !== undefined && parentId !== undefined) {
      throw new Error("Attached child orders must not include a client order ID");
    }
    const identity = clientOrderId ?? parentId;
    if (!identity?.trim() || identity.length > 64) {
      throw new Error(
        parentId === undefined
          ? "Client order ID must contain 1 to 64 characters"
          : "Parent order ID must contain 1 to 64 characters"
      );
    }
  }

  private validateSingleOrderFields(
    request:
      | DerivativeSingleOrderRequest
      | DerivativeContingentParentOrderRequest
      | DerivativeContingentChildOrderRequest
  ): void {
    if (!request.accountId.trim()) throw new Error("An explicit IBKR account ID is required");
    const orderType: unknown = request.orderType;
    if (orderType !== "LMT" && orderType !== "STP") {
      throw new Error("Order type must be LMT or STP");
    }
    if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0) {
      throw new Error("Order quantity must be a positive integer");
    }
    if (!Number.isSafeInteger(request.contract.conid) || request.contract.conid <= 0) {
      throw new Error("Order contract has an invalid IBKR conid");
    }
    if (request.orderType === "LMT") {
      const limit: unknown = (request as unknown as { limit?: unknown }).limit;
      if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
        throw new Error("LIMIT order requires a positive limit price");
      }
    }
    if (request.orderType === "STP") {
      const stopPrice: unknown = (request as unknown as { stopPrice?: unknown }).stopPrice;
      if (typeof stopPrice !== "number" || !Number.isFinite(stopPrice) || stopPrice <= 0) {
        throw new Error("STOP order requires a positive stop price");
      }
    }
  }

  private cmeOperatorMetadata(
    assetClass: DerivativeAssetClass,
    input: { extOperator?: string; manualIndicator?: boolean }
  ): { extOperator: string; manualIndicator: boolean } | Record<string, never> {
    if (assetClass === "OPT") return {};
    if (!input.extOperator?.trim() || input.manualIndicator === undefined) {
      throw new Error(`${assetClass} orders require exact CME operator metadata`);
    }
    return {
      extOperator: input.extOperator,
      manualIndicator: input.manualIndicator,
    };
  }

  private comboOrderTicket(request: DerivativeComboPreviewRequest): {
    acctId: string;
    conidex: string;
    orderType: "LMT" | "STP";
    price: number;
    side: "BUY";
    tif: "DAY" | "GTC";
    quantity: number;
    outsideRTH: boolean;
  } {
    const exchange = request.legs[0].contract.exchange;
    const spreadConid = exchange === "SMART" ? "28812380" : `28812380@${exchange}`;
    const amount = request.orderType === "LMT" ? request.limit : request.stopPrice;
    return {
      acctId: request.accountId,
      conidex: `${spreadConid};;;${request.legs
        .map(({ contract, ratio }) => `${String(contract.conid)}/${String(ratio)}`)
        .join(",")}`,
      orderType: request.orderType,
      price: request.priceEffect === "CREDIT" ? -amount : amount,
      side: "BUY",
      tif: request.tif,
      quantity: request.quantity,
      outsideRTH: request.session === "OVERNIGHT",
    };
  }

  private singleOrderTicket(
    request:
      | DerivativeSingleOrderRequest
      | DerivativeContingentParentOrderRequest
      | DerivativeContingentChildOrderRequest
  ): {
    acctId: string;
    conid: number;
    orderType: "LMT" | "STP";
    side: "BUY" | "SELL";
    price: number;
    tif: "DAY" | "GTC";
    quantity: number;
    outsideRTH: boolean;
  } {
    return {
      acctId: request.accountId,
      conid: request.contract.conid,
      orderType: request.orderType,
      side: request.side,
      price: request.orderType === "LMT" ? request.limit : request.stopPrice,
      tif: request.tif,
      quantity: request.quantity,
      outsideRTH: request.session === "OVERNIGHT",
    };
  }

  private normalizeOrderSubmission(
    response: IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[],
    clientOrderId: string | null
  ): DerivativeOrderSubmissionResult {
    const decoded = this.decodeOrderSubmission(response);
    const correlatedClientOrderId = decoded.orders.length === 1 ? clientOrderId : null;
    const orders = decoded.orders.map((order) => ({
      ...order,
      clientOrderId: correlatedClientOrderId,
    }));
    const hasWarnings = decoded.warnings.length > 0;
    const hasErrors = decoded.errors.length > 0;
    const hasUnknown = decoded.unrecognizedResponses.length > 0;
    const hasPendingCancel = decoded.pendingCancelOrderIds.length > 0;

    if (decoded.warnings.length === 1 && !hasErrors && orders.length === 0 && !hasUnknown) {
      return { state: "warning", warnings: decoded.warnings };
    }
    if (
      hasErrors &&
      !decoded.responseIsArray &&
      !hasWarnings &&
      orders.length === 0 &&
      !hasUnknown
    ) {
      return {
        state: "rejected",
        reasons: decoded.errors.map(({ message }) => message),
        errors: decoded.errors,
      };
    }
    if (!hasWarnings && !hasErrors && !hasUnknown && !hasPendingCancel && orders.length === 1) {
      const order = orders[0];
      if (order === undefined) throw new Error("Single-order normalization lost order evidence");
      if (order.status === "REJECTED" || order.status === "CANCELED") {
        return {
          state: "rejected",
          reasons: [`Order ${order.orderId} returned terminal status ${order.status}`],
          errors: [],
          orders,
        };
      }
      if (order.status !== "UNKNOWN") {
        return { state: "accepted", ...order, warnings: [] };
      }
    }

    return this.singleOrderRecoveryResult(decoded, orders);
  }

  private graphMemberEvidence(
    request: DerivativeOrderGraphRequest,
    node: DerivativeOrderGraphNode,
    order?: IbkrLiveOrder
  ): DerivativeOrderGraphMemberEvidence {
    const index = request.nodes.findIndex(({ memberId }) => memberId === node.memberId);
    let depth = 0;
    let parentId = node.parentMemberId;
    while (parentId !== undefined) {
      depth += 1;
      parentId = request.nodes.find(({ memberId }) => memberId === parentId)?.parentMemberId;
    }
    const rawId = order?.order_id ?? order?.orderId;
    const orderId =
      typeof rawId === "string" || typeof rawId === "number" ? String(rawId).trim() || null : null;
    const filledQuantity = this.firstNumber(
      order?.cum_fill,
      order?.cumFill,
      order?.filledQuantity,
      order?.filled
    );
    const quantity = this.firstPositiveNumber(order?.total_size, order?.totalSize, order?.size);
    const remainingQuantity =
      this.firstNumber(order?.remainingQuantity, order?.remaining_size, order?.remaining) ??
      (quantity !== undefined && filledQuantity !== undefined
        ? Math.max(0, quantity - filledQuantity)
        : undefined);
    return {
      memberId: node.memberId,
      role:
        index < 0
          ? "unknown"
          : depth === 0
            ? "root"
            : depth === 1
              ? "child"
              : depth === 2
                ? "grandchild"
                : "descendant",
      parentMemberId: node.parentMemberId ?? null,
      parentOrderId: null,
      orderId,
      status:
        order === undefined
          ? "WARNING_PENDING"
          : this.normalizeDerivativeOrderStatus(
              order.order_status ?? order.orderStatus ?? order.status,
              filledQuantity ?? 0,
              remainingQuantity ?? 0
            ),
      clientOrderId: this.graphClientOrderId(request, node),
      request: node,
    };
  }

  private attachGraphParentOrderIds(
    members: DerivativeOrderGraphMemberEvidence[]
  ): DerivativeOrderGraphMemberEvidence[] {
    const ids = new Map(members.map(({ memberId, orderId }) => [memberId, orderId]));
    return members.map((member) => ({
      ...member,
      parentOrderId:
        member.parentMemberId === null ? null : (ids.get(member.parentMemberId) ?? null),
    }));
  }

  private normalizeOrderGraphSubmission(
    response: IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[],
    request: DerivativeOrderGraphRequest,
    previousMembers: DerivativeOrderGraphMemberEvidence[]
  ): DerivativeOrderGraphResult {
    const decoded = this.decodeOrderSubmission(response);
    const cleanOrders =
      decoded.warnings.length === 0 &&
      decoded.errors.length === 0 &&
      decoded.unrecognizedResponses.length === 0;
    const distinct =
      new Set(decoded.orders.map(({ orderId }) => orderId)).size === decoded.orders.length;
    const ordersByClientOrderId = new Map<string, DerivativeSubmittedOrder[]>();
    for (const order of decoded.orders) {
      if (order.clientOrderId === null) continue;
      const matchingOrders = ordersByClientOrderId.get(order.clientOrderId) ?? [];
      matchingOrders.push(order);
      ordersByClientOrderId.set(order.clientOrderId, matchingOrders);
    }
    const correlatedOrders = new Set<DerivativeSubmittedOrder>();
    const members = this.attachGraphParentOrderIds(
      request.nodes.map((node) => {
        const matchingOrders = ordersByClientOrderId.get(this.graphClientOrderId(request, node));
        const order = matchingOrders?.length === 1 ? matchingOrders[0] : undefined;
        if (order === undefined)
          return (
            previousMembers.find(({ memberId }) => memberId === node.memberId) ??
            this.graphMemberEvidence(request, node)
          );
        correlatedOrders.add(order);
        const evidence = this.graphMemberEvidence(request, node, {
          order_id: order.orderId,
          order_status: order.status,
        });
        return { ...evidence, status: order.status };
      })
    );
    const memberOrderIds = members.map(({ orderId }) => orderId);
    const hasCompleteMemberOrderIds =
      memberOrderIds.every((orderId): orderId is string => orderId !== null) &&
      new Set(memberOrderIds).size === request.nodes.length;
    const hasCompleteIdentityCorrelation =
      distinct &&
      decoded.orders.length === request.nodes.length &&
      correlatedOrders.size === request.nodes.length &&
      hasCompleteMemberOrderIds;
    if (
      decoded.warnings.length === 1 &&
      decoded.orders.length === 0 &&
      decoded.errors.length === 0 &&
      decoded.unrecognizedResponses.length === 0
    ) {
      const warning = decoded.warnings[0];
      if (warning === undefined) throw new Error("Graph warning evidence was lost");
      return {
        state: "warning",
        rootClientOrderId: request.rootClientOrderId,
        members,
        warnings: decoded.warnings,
        continuation: { replyId: warning.replyId, request, members },
      };
    }
    if (
      decoded.errors.length > 0 &&
      !decoded.responseIsArray &&
      decoded.orders.length === 0 &&
      decoded.warnings.length === 0 &&
      decoded.unrecognizedResponses.length === 0
    ) {
      return {
        state: "rejected",
        rootClientOrderId: request.rootClientOrderId,
        members,
        reasons: decoded.errors.map(({ message }) => message),
        errors: decoded.errors,
      };
    }
    if (
      cleanOrders &&
      hasCompleteIdentityCorrelation &&
      decoded.pendingCancelOrderIds.length === 0 &&
      decoded.orders.every(
        ({ status }) => status !== "UNKNOWN" && status !== "REJECTED" && status !== "CANCELED"
      )
    ) {
      return {
        state: "accepted",
        rootClientOrderId: request.rootClientOrderId,
        members,
        warnings: [],
      };
    }
    const membersMissingOrderIds = members
      .filter(({ orderId }) => orderId === null)
      .map(({ memberId }) => memberId);
    const hasNonFailureOrderStatuses = decoded.orders.every(
      ({ status }) => status !== "UNKNOWN" && status !== "REJECTED" && status !== "CANCELED"
    );
    const hasIdentityCorrelationFailure =
      decoded.pendingCancelOrderIds.length === 0 &&
      decoded.errors.length === 0 &&
      hasNonFailureOrderStatuses &&
      decoded.orders.length === request.nodes.length &&
      !hasCompleteIdentityCorrelation;
    const hasNamedMissingMemberIds =
      membersMissingOrderIds.length > 0 &&
      decoded.pendingCancelOrderIds.length === 0 &&
      decoded.errors.length === 0 &&
      hasNonFailureOrderStatuses &&
      !hasIdentityCorrelationFailure;
    return {
      state: "recovery_required",
      rootClientOrderId: request.rootClientOrderId,
      members,
      reasons: [
        hasIdentityCorrelationFailure
          ? "IBKR did not return a unique client order identity for each graph member"
          : hasNamedMissingMemberIds
            ? `IBKR graph submission is missing broker order IDs for member(s): ${membersMissingOrderIds.join(", ")}`
            : this.submissionRecoveryReason(decoded, decoded.orders.length, request.nodes.length),
      ],
      warnings: decoded.warnings,
      errors: decoded.errors,
      unrecognizedResponses: [
        ...decoded.unrecognizedResponses,
        ...decoded.orders
          .filter(
            (order) =>
              !correlatedOrders.has(order) && !decoded.invalidClientOrderIdentityOrders.has(order)
          )
          .map((order) => decoded.rawOrderResponses.get(order) ?? order),
      ],
    };
  }

  private normalizeOrderCancellation(
    input: DerivativeOrderCancelRequest,
    response: unknown
  ): DerivativeOrderCancellationResult {
    const record = isUnknownRecord(response) ? response : null;
    const message = this.trimmedString(record?.["msg"]);
    const accountId = this.trimmedString(record?.["account"]);
    const orderId = this.cancellationOrderId(record?.["order_id"]);
    const errorParts = record === null ? [] : this.cancellationErrorParts(record);
    const evidence: DerivativeOrderCancellationEvidence = {
      message,
      accountId,
      orderId,
      error: errorParts.length > 0 ? errorParts.join("; ").slice(0, 4_096) : null,
      response: this.sanitizeJsonEvidence(response),
    };
    const accountProvided = record !== null && "account" in record;
    const orderProvided = record !== null && "order_id" in record;
    const conidProvided = record !== null && "conid" in record;
    const conid = record?.["conid"];
    const unknownFields =
      record === null
        ? []
        : Object.keys(record).filter(
            (key) => key !== "msg" && key !== "account" && key !== "order_id" && key !== "conid"
          );
    let reason: string | null = null;
    if (record === null) reason = "IBKR returned a malformed cancellation response";
    else if (errorParts.length > 0) reason = "IBKR returned cancellation error evidence";
    else if (unknownFields.length > 0) reason = "IBKR returned undocumented cancellation fields";
    else if (message !== "Request was submitted")
      reason = "IBKR did not confirm the cancellation request";
    else if (accountProvided && accountId === null)
      reason = "IBKR returned malformed cancellation account evidence";
    else if (orderProvided && orderId === null)
      reason = "IBKR returned malformed cancellation order evidence";
    else if (
      conidProvided &&
      (typeof conid !== "number" || !Number.isSafeInteger(conid) || conid <= 0)
    )
      reason = "IBKR returned malformed cancellation conid evidence";
    else if (accountId !== null && accountId !== input.accountId)
      reason = "IBKR cancellation account evidence conflicts with the request";
    else if (orderId !== null && orderId !== input.orderId)
      reason = "IBKR cancellation order evidence conflicts with the request";

    if (reason !== null || message === null) {
      return {
        state: "recovery_required",
        accountId: input.accountId,
        orderId: input.orderId,
        reason: reason ?? "IBKR did not confirm the cancellation request",
        evidence,
      };
    }
    return {
      state: "requested",
      accountId: input.accountId,
      orderId: input.orderId,
      message,
    };
  }

  private sanitizeJsonEvidence(value: unknown): IbkrJsonEvidence {
    const seen = new WeakMap<object, string>();
    let remainingEntries = 500;
    const dictionary = (): Record<string, IbkrJsonEvidence> =>
      Object.create(null) as Record<string, IbkrJsonEvidence>;
    const markerKey = (
      source: object,
      result: Readonly<Record<string, IbkrJsonEvidence>>,
      label: string
    ): string => {
      let key = label;
      while (
        Object.prototype.hasOwnProperty.call(source, key) ||
        Object.prototype.hasOwnProperty.call(result, key)
      ) {
        key += "#";
      }
      return key;
    };
    const sanitize = (item: unknown, depth: number, path: string): IbkrJsonEvidence => {
      if (item === null || typeof item === "boolean" || typeof item === "string") return item;
      if (typeof item === "number") {
        return Number.isFinite(item) ? item : `[non-json number: ${String(item)}]`;
      }
      if (typeof item !== "object") return `[non-json ${typeof item}]`;
      const priorPath = seen.get(item);
      if (priorPath !== undefined) return `[reference: ${priorPath}]`;
      seen.set(item, path);
      if (depth >= 8) {
        const result = dictionary();
        result[markerKey(item, result, "[truncated: depth]")] = true;
        return result;
      }
      if (Array.isArray(item)) {
        const result: IbkrJsonEvidence[] = [];
        for (const [index, member] of item.entries()) {
          if (remainingEntries <= 0) {
            result.push("[truncated: entry count]");
            break;
          }
          remainingEntries -= 1;
          result.push(sanitize(member, depth + 1, `${path}[${String(index)}]`));
        }
        return result;
      }
      const result = dictionary();
      for (const ownKey of Reflect.ownKeys(item)) {
        if (remainingEntries <= 0) {
          result[markerKey(item, result, "[truncated: entry count]")] = true;
          break;
        }
        remainingEntries -= 1;
        const key =
          typeof ownKey === "string"
            ? ownKey
            : markerKey(item, result, `[non-json symbol key: ${ownKey.description ?? ""}]`);
        let member: unknown;
        try {
          member = Reflect.get(item, ownKey);
        } catch {
          member = "[unreadable property]";
        }
        result[key] = sanitize(member, depth + 1, `${path}.${JSON.stringify(key)}`);
      }
      return result;
    };
    const sanitized = sanitize(value, 0, "$");
    const encoded = JSON.stringify(sanitized);
    if (encoded.length <= 8_192) return sanitized;

    const fallback = dictionary();
    fallback["[truncated: evidence size]"] = true;
    fallback["originalSerializedLength"] = encoded.length;
    let low = 0;
    let high = encoded.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      fallback["preview"] = encoded.slice(0, middle);
      if (JSON.stringify(fallback).length <= 8_192) low = middle;
      else high = middle - 1;
    }
    fallback["preview"] = encoded.slice(0, low);
    return fallback;
  }

  private cancellationOrderId(value: unknown): string | null {
    if (typeof value === "string") return this.trimmedString(value);
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : null;
  }

  private cancellationErrorParts(record: Readonly<Record<string, unknown>>): string[] {
    const parts: string[] = [];
    for (const key of ["error", "message", "text"] as const) {
      if (!(key in record)) continue;
      const text = this.trimmedString(record[key]);
      parts.push(text === null ? `${key}: present` : `${key}: ${text}`);
    }
    for (const key of ["statusCode", "code"] as const) {
      if (!(key in record)) continue;
      const value = record[key];
      parts.push(
        typeof value === "string" || typeof value === "number"
          ? `${key}: ${String(value)}`
          : `${key}: present`
      );
    }
    if (record["success"] === false) parts.push("success: false");
    return parts;
  }

  private normalizeMultiOrderSubmission(
    response: IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[],
    parentClientOrderId: string,
    accountId: string
  ): DerivativeMultiOrderResult {
    const decoded = this.decodeOrderSubmission(response);
    const hasDistinctBrokerOrderIds =
      decoded.orders.length === 2 &&
      new Set(decoded.orders.map(({ orderId }) => orderId)).size === 2;
    const rolesArePositionallyComplete =
      decoded.orders.length === 2 &&
      hasDistinctBrokerOrderIds &&
      decoded.warnings.length === 0 &&
      decoded.unrecognizedResponses.length === 0;
    const orders = decoded.orders.map<DerivativeContingentOrderEvidence>((order, index) => ({
      ...order,
      clientOrderId: rolesArePositionallyComplete && index === 0 ? parentClientOrderId : null,
      role:
        rolesArePositionallyComplete && index === 0
          ? "parent"
          : rolesArePositionallyComplete && index === 1
            ? "child"
            : "unknown",
    }));
    const hasWarnings = decoded.warnings.length > 0;
    const hasErrors = decoded.errors.length > 0;
    const hasUnknown = decoded.unrecognizedResponses.length > 0;

    if (decoded.warnings.length === 1 && !hasErrors && orders.length === 0 && !hasUnknown) {
      const warning = decoded.warnings[0];
      if (warning === undefined) throw new Error("Contingent warning evidence was lost");
      return {
        state: "warning",
        warnings: decoded.warnings,
        continuation: { accountId, replyId: warning.replyId, parentClientOrderId },
      };
    }
    if (
      hasErrors &&
      !decoded.responseIsArray &&
      !hasWarnings &&
      orders.length === 0 &&
      !hasUnknown
    ) {
      return {
        state: "rejected",
        parentClientOrderId,
        reasons: decoded.errors.map(({ message }) => message),
        errors: decoded.errors,
      };
    }
    if (
      !hasWarnings &&
      !hasErrors &&
      !hasUnknown &&
      decoded.pendingCancelOrderIds.length === 0 &&
      orders.length === 2 &&
      hasDistinctBrokerOrderIds
    ) {
      const [parent, child] = orders;
      if (parent !== undefined && child !== undefined) {
        const terminalFailure = orders.find(
          ({ status }) => status === "REJECTED" || status === "CANCELED"
        );
        const unknownStatus = orders.find(({ status }) => status === "UNKNOWN");
        if (terminalFailure === undefined && unknownStatus === undefined) {
          return { state: "accepted", orders: [parent, child], warnings: [] };
        }
      }
    }

    return this.contingentRecoveryResult(decoded, orders, parentClientOrderId);
  }

  private flattenOrderSubmissionItems(response: unknown): {
    responseIsArray: boolean;
    items: unknown[];
    malformedNesting: unknown[];
  } {
    const responseIsArray = Array.isArray(response);
    const rootItems = responseIsArray ? response : [response];
    const items: unknown[] = [];
    const malformedNesting: unknown[] = [];
    const visiting = new Set<object>();

    const visit = (rawItems: readonly unknown[]): void => {
      for (const item of rawItems) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          items.push(item);
          continue;
        }
        if (visiting.has(item)) {
          malformedNesting.push({ ...item });
          continue;
        }
        visiting.add(item);
        const record = item as Readonly<Record<string, unknown>>;
        const childCollections = [record["childOrders"], record["children"]];
        const hasMalformedChildCollection = childCollections.some(
          (children) => children !== undefined && !Array.isArray(children)
        );
        items.push(item);
        if (hasMalformedChildCollection) {
          malformedNesting.push({ ...record });
          visiting.delete(item);
          continue;
        }
        const children = new Set<unknown>();
        for (const collection of childCollections) {
          if (!Array.isArray(collection)) continue;
          for (const child of collection) children.add(child);
        }
        if (children.size > 0) visit([...children]);
        visiting.delete(item);
      }
    };

    visit(rootItems);
    return { responseIsArray, items, malformedNesting };
  }

  private decodeOrderSubmission(response: unknown): DecodedOrderSubmission {
    const { responseIsArray, items, malformedNesting } = this.flattenOrderSubmissionItems(response);
    const decoded: DecodedOrderSubmission = {
      responseIsArray,
      orders: [],
      rawOrderResponses: new Map(),
      invalidClientOrderIdentityOrders: new Set(),
      pendingCancelOrderIds: [],
      warnings: [],
      errors: [],
      unrecognizedResponses: [...malformedNesting],
    };
    for (const item of items) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        decoded.unrecognizedResponses.push(item);
        continue;
      }
      const record = item as Readonly<Record<string, unknown>>;
      let recognized = false;
      const rawWarningId = record["id"];
      if (typeof rawWarningId === "string" && rawWarningId.trim()) {
        const rawMessageIds = record["messageIds"];
        const messageIds = Array.isArray(rawMessageIds)
          ? rawMessageIds.filter((value): value is string => typeof value === "string")
          : [];
        decoded.warnings.push({
          replyId: rawWarningId.trim(),
          messages: Array.isArray(record["message"])
            ? record["message"].filter((value): value is string => typeof value === "string")
            : [],
          messageIds,
          known:
            Array.isArray(rawMessageIds) &&
            rawMessageIds.length > 0 &&
            rawMessageIds.every((id) => typeof id === "string"),
        });
        recognized = true;
      } else if ("id" in record) {
        decoded.unrecognizedResponses.push({ ...record });
        recognized = true;
      }
      if (record["error"] !== undefined && record["error"] !== null) {
        if (this.isMeaningfulBrokerError(record["error"], record)) {
          decoded.errors.push(this.normalizeBrokerError(record["error"], record));
        } else {
          decoded.unrecognizedResponses.push({ ...record });
        }
        recognized = true;
      }
      const orderStatus = record["order_status"] ?? record["orderStatus"];
      const canonicalOrderStatus = this.canonicalIbkrOrderStatus(orderStatus);
      if (
        (record["error"] === undefined || record["error"] === null) &&
        (canonicalOrderStatus === "FAILED" || canonicalOrderStatus === "REJECTED") &&
        this.isMeaningfulBrokerError(record["text"] ?? record["warning_message"], record)
      ) {
        decoded.errors.push(
          this.normalizeBrokerError(record["text"] ?? record["warning_message"], record)
        );
        recognized = true;
      }
      const hasOrderId = "order_id" in record || "orderId" in record;
      const rawOrderId = record["order_id"] ?? record["orderId"];
      const orderId =
        typeof rawOrderId === "string" && rawOrderId.trim()
          ? rawOrderId.trim()
          : typeof rawOrderId === "number" && Number.isSafeInteger(rawOrderId) && rawOrderId > 0
            ? String(rawOrderId)
            : null;
      if (orderId !== null) {
        if (
          typeof orderStatus === "string" &&
          this.canonicalIbkrOrderStatus(orderStatus) === "PENDING_CANCEL"
        ) {
          decoded.pendingCancelOrderIds.push(orderId);
        }
        const clientOrderIdentity = this.consistentStringAliases(
          record["local_order_id"],
          record["cOID"]
        );
        const order: DerivativeSubmittedOrder = {
          orderId,
          status: this.normalizeDerivativeOrderStatus(
            typeof orderStatus === "string" ? orderStatus : undefined,
            0,
            0
          ),
          clientOrderId: clientOrderIdentity.value ?? null,
        };
        decoded.orders.push(order);
        decoded.rawOrderResponses.set(order, { ...record });
        if (!clientOrderIdentity.valid) {
          decoded.invalidClientOrderIdentityOrders.add(order);
          decoded.unrecognizedResponses.push({ ...record });
        }
        recognized = true;
      } else if (hasOrderId) {
        decoded.unrecognizedResponses.push({ ...record });
        recognized = true;
      }
      if (!recognized) decoded.unrecognizedResponses.push({ ...record });
    }
    if (items.length === 0) decoded.unrecognizedResponses.push({});
    return decoded;
  }

  private singleOrderRecoveryResult(
    decoded: DecodedOrderSubmission,
    orders: DerivativeSubmittedOrder[]
  ): DerivativeOrderSubmissionResult {
    return {
      state: "recovery_required",
      reasons: [this.submissionRecoveryReason(decoded, orders.length, 1)],
      orders,
      warnings: decoded.warnings,
      errors: decoded.errors,
      unrecognizedResponses: decoded.unrecognizedResponses,
    };
  }

  private contingentRecoveryResult(
    decoded: DecodedOrderSubmission,
    orders: DerivativeContingentOrderEvidence[],
    parentClientOrderId: string
  ): DerivativeMultiOrderResult {
    return {
      state: "recovery_required",
      parentClientOrderId,
      reasons: [this.submissionRecoveryReason(decoded, orders.length, 2)],
      orders,
      warnings: decoded.warnings,
      errors: decoded.errors,
      unrecognizedResponses: decoded.unrecognizedResponses,
    };
  }

  private submissionRecoveryReason(
    decoded: DecodedOrderSubmission,
    orderCount: number,
    expectedOrderCount: number
  ): string {
    const pendingCancelOrderId = decoded.pendingCancelOrderIds[0];
    if (pendingCancelOrderId !== undefined) {
      return `Order ${pendingCancelOrderId} has a pending cancellation`;
    }
    const error = decoded.errors[0];
    if (error !== undefined) return error.message;
    const terminal = decoded.orders.find(
      ({ status }) => status === "REJECTED" || status === "CANCELED"
    );
    if (terminal !== undefined) {
      return `Order ${terminal.orderId} returned terminal status ${terminal.status}`;
    }
    if (decoded.orders.some(({ status }) => status === "UNKNOWN")) {
      return "IBKR returned an order ID with an unknown status";
    }
    if (new Set(decoded.orders.map(({ orderId }) => orderId)).size < decoded.orders.length) {
      return "IBKR returned duplicate broker order IDs";
    }
    if (decoded.errors.length > 0 && decoded.warnings.length > 0) {
      return "IBKR returned both warnings and rejections for one submission";
    }
    if (decoded.warnings.length > 1) {
      return "IBKR returned multiple warning continuations for one submission";
    }
    if (orderCount !== expectedOrderCount) {
      return `IBKR returned ${String(orderCount)} of ${String(expectedOrderCount)} expected order acknowledgements`;
    }
    if (decoded.unrecognizedResponses.length > 0) {
      return "IBKR returned one or more unrecognized order responses";
    }
    return "IBKR returned mixed or incomplete order evidence";
  }

  private normalizeBrokerError(
    error: unknown,
    response: Readonly<Record<string, unknown>>,
    defaultMessage = "IBKR rejected the order"
  ): BrokerErrorDetail {
    const nested = typeof error === "object" && error !== null ? error : undefined;
    const nestedMessage = nested ? (nested as { message?: unknown }).message : undefined;
    const responseMessage = response["message"];
    const responseText = response["text"];
    const responseWarningMessage = response["warning_message"];
    const message =
      (typeof nestedMessage === "string" && nestedMessage.trim()) ||
      (typeof error === "string" && error.trim()) ||
      (typeof responseMessage === "string" && responseMessage.trim()) ||
      (typeof responseText === "string" && responseText.trim()) ||
      (typeof responseWarningMessage === "string" && responseWarningMessage.trim()) ||
      defaultMessage;
    const nestedCode = nested ? (nested as { code?: unknown }).code : undefined;
    const responseCode = response["code"];
    const codeValue = nestedCode ?? responseCode;
    const statusValue = response["statusCode"];
    return {
      message,
      code:
        typeof codeValue === "string" || typeof codeValue === "number" ? String(codeValue) : null,
      statusCode:
        typeof statusValue === "number" && Number.isFinite(statusValue) ? statusValue : null,
      details: response,
    };
  }

  /**
   * Validate `iserver/secdef/search` at one shared boundary.
   * Accept the documented success array, convert the documented error object into a typed
   * broker error, and fail closed on any other shape. Never treat an error object as an empty
   * successful search.
   */
  private parseSecdefSearchResponse(response: unknown): IbkrSecdefSearchResult[] {
    if (Array.isArray(response)) {
      return response as IbkrSecdefSearchResult[];
    }
    if (
      isUnknownRecord(response) &&
      response["error"] !== undefined &&
      response["error"] !== null
    ) {
      // Any non-null `error` field is the documented IBKR error-object shape for this
      // endpoint. Do not reclassify it as a malformed payload when the message is empty.
      const detail = this.normalizeBrokerError(
        response["error"],
        response,
        "IBKR rejected the security-definition search"
      );
      throw new IbkrBrokerResponseError(detail.message, detail);
    }
    throw new Error("IBKR returned a malformed secdef/search response");
  }

  /** Serialize IBKR operations that mutate and then consume session security-definition state. */
  private withSecdefPriming<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.secdefPrimingTail.then(operation);
    this.secdefPrimingTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Run one state-mutating search outside a larger priming transaction. */
  private searchSecdef(
    params: Record<string, string | number | boolean | null | undefined>
  ): Promise<IbkrSecdefSearchResult[]> {
    return this.withSecdefPriming(async () =>
      this.parseSecdefSearchResponse(
        await this.req<unknown>({ path: "iserver/secdef/search", params })
      )
    );
  }

  private isMeaningfulBrokerError(
    error: unknown,
    response: Readonly<Record<string, unknown>>
  ): boolean {
    const nested = typeof error === "object" && error !== null ? error : undefined;
    const nestedRecord = nested as Readonly<Record<string, unknown>> | undefined;
    const messages = [
      error,
      nestedRecord?.["message"],
      response["message"],
      response["text"],
      response["warning_message"],
    ];
    if (messages.some((value) => typeof value === "string" && value.trim())) return true;

    const code = nestedRecord?.["code"] ?? response["code"];
    if (
      (typeof code === "string" && code.trim()) ||
      (typeof code === "number" && Number.isFinite(code))
    ) {
      return true;
    }

    const status =
      nestedRecord?.["statusCode"] ?? nestedRecord?.["status"] ?? response["statusCode"];
    return typeof status === "number" && Number.isFinite(status) && status >= 400;
  }

  private normalizeDerivativeOrderLifecycle(
    accountId: string,
    orderId: string,
    order: IbkrLiveOrder
  ): DerivativeOrderLifecycle {
    const quantity = this.firstPositiveNumber(order.total_size, order.totalSize, order.size);
    const filledQuantity = this.firstNumber(
      order.cum_fill,
      order.cumFill,
      order.filledQuantity,
      order.filled
    );
    // `iserver/account/order/status/{orderId}` never carries a remaining-quantity field: it
    // reports only `total_size` and `cum_fill`. Derive the remainder from those two authoritative
    // values, exactly as `normalizeActiveDerivativeOrder` already does for the order snapshot.
    // Nothing is invented here - if either input is missing, this stays `undefined` and the
    // lifecycle read still fails closed below.
    const remainingQuantity =
      this.firstNumber(order.remainingQuantity, order.remaining_size, order.remaining) ??
      (quantity !== undefined && filledQuantity !== undefined && filledQuantity >= 0
        ? Math.max(0, quantity - filledQuantity)
        : undefined);
    if (
      quantity === undefined ||
      filledQuantity === undefined ||
      filledQuantity < 0 ||
      remainingQuantity === undefined ||
      remainingQuantity < 0
    ) {
      throw new Error(`IBKR order ${orderId} returned incomplete fill quantities`);
    }
    return {
      accountId,
      orderId,
      clientOrderId: order.cOID ?? order.order_ref ?? null,
      status: this.normalizeDerivativeOrderStatus(
        order.order_status ?? order.orderStatus ?? order.status,
        filledQuantity,
        remainingQuantity
      ),
      quantity,
      filledQuantity,
      remainingQuantity,
      averagePrice:
        this.firstNumber(
          order.avgPrice,
          order.avg_price,
          order.average_price,
          order.averagePrice
        ) ?? null,
      // The exact read and the active snapshot must describe one order the same way, so both
      // carry the order type and the stop trigger from the same broker fields. Nothing is
      // inferred: each stays `null` when IBKR sends no value.
      orderType: this.normalizeOrderType(order.order_type ?? order.orderType) ?? null,
      limitPrice: this.firstNumber(order.limitPrice, order.limit_price, order.price) ?? null,
      stopPrice: this.firstNumber(order.stopPrice, order.stop_price) ?? null,
      commissionAndFees:
        typeof order.commissionAndFees === "number"
          ? order.commissionAndFees
          : this.whatIfNumber(order.commissionAndFees),
      legs: this.parseComboLegs(order.conidex),
      updatedAt: this.parseOrderTime(order)?.toISOString() ?? null,
    };
  }

  private flattenCompleteOrderSnapshot(
    response: unknown
  ): { order: IbkrLiveOrder; nestedParent: IbkrLiveOrder | null }[] | null {
    if (typeof response !== "object" || response === null || Array.isArray(response)) return null;
    const record = response as Record<string, unknown>;
    if (record["snapshot"] !== true || !Array.isArray(record["orders"])) return null;

    const flattened: { order: IbkrLiveOrder; nestedParent: IbkrLiveOrder | null }[] = [];
    const visiting = new Set<object>();
    const visit = (orders: readonly unknown[], nestedParent: IbkrLiveOrder | null): boolean => {
      for (const rawOrder of orders) {
        if (typeof rawOrder !== "object" || rawOrder === null || Array.isArray(rawOrder))
          return false;
        if (visiting.has(rawOrder)) return false;
        visiting.add(rawOrder);
        const orderRecord = rawOrder as Record<string, unknown>;
        const childCollections = [orderRecord["childOrders"], orderRecord["children"]];
        if (
          childCollections.some((children) => children !== undefined && !Array.isArray(children))
        ) {
          return false;
        }
        const order = rawOrder as IbkrLiveOrder;
        flattened.push({ order, nestedParent });
        const children = new Set<unknown>();
        for (const collection of childCollections) {
          if (Array.isArray(collection)) {
            for (const child of collection as unknown[]) children.add(child);
          }
        }
        if (!visit([...children], order)) return false;
        visiting.delete(rawOrder);
      }
      return true;
    };

    return visit(record["orders"], null) ? flattened : null;
  }

  private normalizeActiveDerivativeOrder(
    accountId: string,
    order: IbkrLiveOrder,
    nestedParent: IbkrLiveOrder | null
  ): ActiveDerivativeOrder {
    const uncertainty: ActiveDerivativeOrderUncertainty[] = [];
    const total = this.firstNumber(order.total_size, order.totalSize, order.size) ?? null;
    const filled =
      this.firstNumber(order.cum_fill, order.cumFill, order.filledQuantity, order.filled) ?? null;
    const remaining =
      this.firstNumber(order.remainingQuantity, order.remaining_size, order.remaining) ??
      (total !== null && filled !== null ? Math.max(0, total - filled) : null);
    if (total === null || filled === null || remaining === null)
      uncertainty.push("INCOMPLETE_QUANTITIES");
    const rawStatus = order.order_status ?? order.orderStatus ?? order.status;
    const status = this.normalizeDerivativeOrderStatus(rawStatus, filled ?? 0, remaining ?? 0);
    if (status === "UNKNOWN") uncertainty.push("UNKNOWN_STATUS");
    const rawOrderId = order.order_id ?? order.orderId;
    if (rawOrderId === undefined) uncertainty.push("MISSING_BROKER_ORDER_ID");
    const explicitParentOrderId = order.parent_order_id ?? order.parentOrderId ?? order.parent_id;
    const explicitParentClientId =
      order.parentClientOrderId ?? order.parent_order_ref ?? order.parentId;
    const nestedBrokerId = nestedParent?.order_id ?? nestedParent?.orderId;
    const nestedClientId = nestedParent?.cOID ?? nestedParent?.order_ref;
    if (
      nestedParent !== null &&
      explicitParentOrderId === undefined &&
      explicitParentClientId === undefined
    ) {
      uncertainty.push("PARTIAL_GRAPH");
    }
    const legs = this.normalizeActiveDerivativeLegs(order, total, uncertainty);
    const orderTime = this.parseOrderTime(order)?.toISOString() ?? null;
    return {
      accountId,
      orderId: rawOrderId === undefined ? null : String(rawOrderId),
      clientOrderId: order.cOID ?? order.order_ref ?? null,
      parentOrderId:
        explicitParentOrderId === undefined
          ? nestedBrokerId === undefined
            ? null
            : String(nestedBrokerId)
          : String(explicitParentOrderId),
      parentClientOrderId:
        explicitParentClientId === undefined
          ? (nestedClientId ?? null)
          : String(explicitParentClientId),
      graphRole:
        nestedParent !== null ||
        explicitParentOrderId !== undefined ||
        explicitParentClientId !== undefined
          ? "CHILD"
          : rawOrderId === undefined
            ? "UNKNOWN"
            : "ROOT",
      status,
      totalQuantity: total,
      filledQuantity: filled,
      remainingQuantity: remaining,
      tif: order.tif ?? order.timeInForce ?? null,
      session:
        order.outsideRTH === true || order.outside_rth === true
          ? "OVERNIGHT"
          : order.outsideRTH === false || order.outside_rth === false
            ? "REGULAR"
            : "UNKNOWN",
      orderType: this.normalizeOrderType(order.order_type ?? order.orderType) ?? null,
      limitPrice: this.firstNumber(order.limitPrice, order.limit_price, order.price) ?? null,
      stopPrice: this.firstNumber(order.stopPrice, order.stop_price) ?? null,
      enteredAt: orderTime,
      updatedAt:
        order.lastExecutionTime_r !== undefined || order.lastExecutionTime !== undefined
          ? orderTime
          : null,
      legs,
      uncertainty,
    };
  }

  private normalizeActiveDerivativeLegs(
    order: IbkrLiveOrder,
    total: number | null,
    orderUncertainty: ActiveDerivativeOrderUncertainty[]
  ): ActiveDerivativeOrderLeg[] {
    const description = [
      order.orderDescriptionWithContract,
      order.order_description_with_contract,
      order.contractDescription1,
      order.contract_description_1,
      order.description1,
      order.symbol,
    ]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    const describedOptions = [...description.matchAll(/([A-Z ]{1,6}\d{6}[CP]\d{8})/gi)].flatMap(
      (match) => {
        const symbol = match[1]?.toUpperCase() ?? "";
        const parsed = parseOsiOptionSymbol(symbol);
        return parsed === null ? [] : [{ symbol, ...parsed }];
      }
    );
    const uniqueDescribedOptions = describedOptions.filter(
      (option, index) =>
        describedOptions.findIndex((candidate) => candidate.symbol === option.symbol) === index
    );
    const side = this.normalizeOrderSide(order.side);
    const signedSide = side === "BUY" ? 1 : side === "SELL" ? -1 : null;
    let rawLegs: {
      conid: number | null;
      ratio: number | null;
      quantityRatio: number | null;
    }[] = [];
    const conidex = typeof order.conidex === "string" ? order.conidex.trim() : null;
    if (conidex?.includes(";;;")) {
      const match = /^(\d+)(?:@[A-Za-z0-9._-]+)?;;;(.+)$/.exec(conidex);
      if (match?.[1] !== "28812380") {
        orderUncertainty.push("MALFORMED_CONIDEX");
      } else {
        rawLegs = (match[2] ?? "").split(",").map((member) => {
          const legMatch = /^(\d+)\/([+-]?\d+)$/.exec(member.trim());
          const conid = Number(legMatch?.[1]);
          const ratio = Number(legMatch?.[2]);
          if (
            !legMatch ||
            !Number.isSafeInteger(conid) ||
            conid <= 0 ||
            !Number.isSafeInteger(ratio) ||
            ratio === 0
          ) {
            return { conid: null, ratio: null, quantityRatio: null };
          }
          return {
            conid,
            ratio: signedSide === null ? null : signedSide * ratio,
            quantityRatio: Math.abs(ratio),
          };
        });
        if (rawLegs.length === 0 || rawLegs.some((leg) => leg.conid === null)) {
          orderUncertainty.push("MALFORMED_CONIDEX");
        }
      }
      if (rawLegs.length === 0) orderUncertainty.push("AGGREGATE_ONLY");
    } else if (Number.isSafeInteger(order.conid) && Number(order.conid) > 0) {
      rawLegs = [{ conid: Number(order.conid), ratio: signedSide, quantityRatio: 1 }];
    } else {
      if (conidex) orderUncertainty.push("MALFORMED_CONIDEX");
      orderUncertainty.push("MISSING_LEG_IDENTITY");
    }
    if (rawLegs.length === 0) {
      rawLegs = [{ conid: null, ratio: null, quantityRatio: null }];
    }
    return rawLegs.map((leg) => {
      const legUncertainty: ActiveDerivativeOrderUncertainty[] = [];
      if (leg.conid === null) legUncertainty.push("MISSING_LEG_IDENTITY");
      if (leg.ratio === null) {
        const directionUncertainty =
          leg.conid !== null && signedSide === null ? "UNKNOWN_SIDE" : "MALFORMED_CONIDEX";
        legUncertainty.push(directionUncertainty);
        if (!orderUncertainty.includes(directionUncertainty)) {
          orderUncertainty.push(directionUncertainty);
        }
      }
      return {
        conid: leg.conid,
        ratio: leg.ratio,
        side: leg.ratio === null ? "UNKNOWN" : leg.ratio > 0 ? "BUY" : "SELL",
        quantity: total === null || leg.quantityRatio === null ? null : total * leg.quantityRatio,
        option:
          rawLegs.length === 1 && uniqueDescribedOptions.length === 1
            ? (uniqueDescribedOptions[0] ?? null)
            : null,
        uncertainty: legUncertainty,
      };
    });
  }

  private addOrderUncertainty(
    order: ActiveDerivativeOrder,
    uncertainty: ActiveDerivativeOrderUncertainty
  ): void {
    if (!order.uncertainty.includes(uncertainty)) order.uncertainty.push(uncertainty);
  }

  private normalizeDerivativeExecution(
    accountId: string,
    trade: IbkrTrade
  ): DerivativeExecution | undefined {
    if (!trade.execution_id || !Number.isSafeInteger(trade.conid) || Number(trade.conid) <= 0) {
      return undefined;
    }
    const commission =
      typeof trade.commission === "number" ? trade.commission : this.whatIfNumber(trade.commission);
    const commissionCurrency =
      typeof trade.commission === "string"
        ? (/\b(?<currency>[A-Z]{3})\s*$/.exec(trade.commission.trim())?.groups?.["currency"] ??
          null)
        : null;
    const side = trade.side?.trim().toUpperCase();
    return {
      accountId,
      executionId: trade.execution_id,
      orderId: trade.order_id === undefined ? null : String(trade.order_id),
      clientOrderId: this.trimmedString(trade.order_ref),
      conid: Number(trade.conid),
      symbol: this.trimmedString(trade.contract_description_1) ?? this.trimmedString(trade.symbol),
      side:
        side === "B" || side === "BUY" || side === "BOT"
          ? "BUY"
          : side === "S" || side === "SELL" || side === "SLD"
            ? "SELL"
            : "UNKNOWN",
      quantity: this.firstNumber(trade.size) ?? 0,
      price: this.firstNumber(trade.price) ?? null,
      commission,
      commissionCurrency,
      netAmount: this.firstNumber(trade.net_amount) ?? null,
      exchange: this.trimmedString(trade.exchange),
      executedAt: this.parseTradeTime(trade),
    };
  }

  private parseTradeTime(trade: IbkrTrade): string | null {
    if (trade.trade_time_r !== undefined) {
      const epoch = new Date(trade.trade_time_r);
      if (!Number.isNaN(epoch.getTime())) return epoch.toISOString();
    }
    const value = trade.trade_time;
    const match = value ? /^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})$/.exec(value) : null;
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match;
    if (!year || !month || !day || !hour || !minute || !second) return null;
    const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  private recoveryOrderId(order: { order_id?: unknown; orderId?: unknown }): string | undefined {
    const identity = this.consistentScalarAliases(order.order_id, order.orderId);
    return identity.valid ? identity.value : undefined;
  }

  private consistentScalarAliases(...aliases: readonly unknown[]): {
    valid: boolean;
    value: string | undefined;
  } {
    const provided = aliases.filter((alias) => alias !== undefined);
    if (provided.length === 0) return { valid: true, value: undefined };
    const normalized = provided.map((alias) => {
      if (typeof alias !== "string" && typeof alias !== "number") return undefined;
      const value = String(alias).trim();
      return value.length === 0 ? undefined : value;
    });
    const [first] = normalized;
    if (first === undefined || normalized.some((value) => value !== first)) {
      return { valid: false, value: undefined };
    }
    return { valid: true, value: first };
  }

  private consistentStringAliases(...aliases: readonly unknown[]): {
    valid: boolean;
    value: string | undefined;
  } {
    const provided = aliases.filter((alias) => alias !== undefined);
    if (provided.length === 0) return { valid: true, value: undefined };
    const normalized = provided.map((alias) =>
      typeof alias === "string" && alias.trim() !== "" ? alias.trim() : undefined
    );
    const [first] = normalized;
    if (first === undefined || normalized.some((value) => value !== first)) {
      return { valid: false, value: undefined };
    }
    return { valid: true, value: first };
  }

  private trimmedString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  private validateReconciliationRequest(request: DerivativeComboReconciliationRequest): void {
    if (!request.accountId.trim() || !request.orderId.trim() || !request.clientOrderId.trim()) {
      throw new Error("Exact account, order, and client order IDs are required for reconciliation");
    }
    if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0) {
      throw new Error("Reconciliation quantity must be a positive integer");
    }
    if (!Number.isFinite(request.multiplier) || request.multiplier <= 0) {
      throw new Error("Reconciliation multiplier must be positive");
    }
    if (
      request.legs.some(
        ({ conid, ratio }) =>
          !Number.isSafeInteger(conid) || conid <= 0 || !Number.isSafeInteger(ratio) || ratio === 0
      ) ||
      request.legs[0].conid === request.legs[1].conid
    ) {
      throw new Error("Reconciliation legs require distinct conids and non-zero integer ratios");
    }
    if ((request.timeoutMs ?? 30_000) < 0 || (request.pollMs ?? 1_000) <= 0) {
      throw new Error("Reconciliation timing must use a non-negative timeout and positive poll");
    }
  }

  private evaluateDerivativeReconciliation(
    request: DerivativeComboReconciliationRequest,
    lifecycle: DerivativeOrderLifecycle,
    trades: DerivativeExecution[]
  ): DerivativeComboReconciliation {
    const base = {
      aggregateStatus: lifecycle.status,
      filledQuantity: lifecycle.filledQuantity,
      remainingQuantity: lifecycle.remainingQuantity,
      multiplier: request.multiplier,
    };
    const recovery = (reason: string): DerivativeComboReconciliation => ({
      ...base,
      state: "RECOVERY_REQUIRED",
      reason,
      legs: [],
      grossPoints: null,
      grossAmount: null,
      commission: null,
      netAmount: null,
    });
    if (lifecycle.quantity !== request.quantity) {
      return recovery("Aggregate order quantity does not match the reviewed combo");
    }
    if (lifecycle.clientOrderId !== null && lifecycle.clientOrderId !== request.clientOrderId) {
      return recovery("Aggregate client order reference does not match the reviewed combo");
    }
    const expectedLegs = request.legs.map(({ conid, ratio }) => ({ conid, ratio }));
    if (JSON.stringify(lifecycle.legs) !== JSON.stringify(expectedLegs)) {
      return recovery("Aggregate combo legs do not match the reviewed combo");
    }

    const matching = trades.filter(({ clientOrderId }) => clientOrderId === request.clientOrderId);
    const executionIds = new Set<string>();
    for (const trade of matching) {
      if (executionIds.has(trade.executionId)) {
        return recovery("Duplicate execution ID requires manual recovery");
      }
      executionIds.add(trade.executionId);
      if (trade.orderId !== null && trade.orderId !== request.orderId) {
        return recovery("Execution order ID does not match the reviewed combo");
      }
      const expected = request.legs.find(({ conid }) => conid === trade.conid);
      if (expected === undefined) {
        return recovery("Execution contains an unexpected combo leg");
      }
      if (trade.side !== this.sideForRatio(expected.ratio)) {
        return recovery("Execution side does not match the reviewed combo ratio");
      }
      if (
        trade.quantity <= 0 ||
        trade.price === null ||
        trade.price < 0 ||
        trade.commission === null ||
        trade.commission < 0 ||
        trade.executedAt === null
      ) {
        return recovery("Execution contains incomplete economics or timing evidence");
      }
    }

    const completeExecutions = matching.flatMap((trade) =>
      trade.side !== "UNKNOWN" &&
      trade.price !== null &&
      trade.commission !== null &&
      trade.executedAt !== null
        ? [
            {
              ...trade,
              side: trade.side,
              price: trade.price,
              commission: trade.commission,
              executedAt: trade.executedAt,
            },
          ]
        : []
    );

    const summaries: DerivativeLegExecutionSummary[] = [];
    for (const expected of request.legs) {
      const executions = completeExecutions.filter(({ conid }) => conid === expected.conid);
      const quantity = executions.reduce((sum, trade) => sum + trade.quantity, 0);
      const expectedQuantity = lifecycle.filledQuantity * Math.abs(expected.ratio);
      if (quantity > expectedQuantity) {
        return recovery("Execution quantity exceeds the aggregate fill");
      }
      if (quantity < expectedQuantity) {
        return {
          ...base,
          state: "PENDING",
          reason: "Terminal order is missing expected execution evidence",
          legs: summaries,
          grossPoints: null,
          grossAmount: null,
          commission: null,
          netAmount: null,
        };
      }
      if (quantity > 0) {
        summaries.push({
          conid: expected.conid,
          side: this.sideForRatio(expected.ratio),
          quantity,
          averagePrice: this.round(
            executions.reduce((sum, trade) => sum + trade.price * trade.quantity, 0) / quantity,
            8
          ),
          commission: this.round(
            executions.reduce((sum, trade) => sum + trade.commission, 0),
            2
          ),
          executionCount: executions.length,
        });
      }
    }

    const cashFlowPoints = completeExecutions.reduce(
      (sum, trade) => sum + (trade.side === "SELL" ? 1 : -1) * trade.price * trade.quantity,
      0
    );
    const grossPoints =
      lifecycle.filledQuantity > 0 ? this.round(cashFlowPoints / lifecycle.filledQuantity, 8) : 0;
    const grossAmount = this.round(cashFlowPoints * request.multiplier, 2);
    const commission = this.round(
      completeExecutions.reduce((sum, trade) => sum + trade.commission, 0),
      2
    );
    const result: DerivativeComboReconciliation = {
      ...base,
      state: this.isTerminalDerivativeStatus(lifecycle.status) ? "VERIFIED" : "PENDING",
      reason: null,
      legs: summaries,
      grossPoints,
      grossAmount,
      commission,
      netAmount: this.round(grossAmount - commission, 2),
    };
    if (lifecycle.status === "FILLED" && lifecycle.filledQuantity !== request.quantity) {
      return recovery("Filled aggregate quantity does not match the reviewed combo");
    }
    return result;
  }

  private sideForRatio(ratio: number): DerivativeExecutionSide {
    return ratio > 0 ? "BUY" : "SELL";
  }

  private isTerminalDerivativeStatus(status: DerivativeOrderStatus): boolean {
    return status === "FILLED" || status === "CANCELED" || status === "REJECTED";
  }

  private round(value: number, decimalPlaces: number): number {
    const factor = 10 ** decimalPlaces;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  private parseComboLegs(conidex: string | undefined): { conid: number; ratio: number }[] {
    const encoded = conidex?.split(";;;")[1];
    if (!encoded) return [];
    return encoded.split(",").flatMap((leg) => {
      const [conidValue, ratioValue] = leg.split("/");
      const conid = Number(conidValue);
      const ratio = Number(ratioValue);
      return Number.isSafeInteger(conid) && conid > 0 && Number.isSafeInteger(ratio) && ratio !== 0
        ? [{ conid, ratio }]
        : [];
    });
  }

  private normalizeDerivativeOrderStatus(
    value: unknown,
    filledQuantity: number,
    remainingQuantity: number
  ): DerivativeOrderStatus {
    const status = this.canonicalIbkrOrderStatus(value);
    if (status === "FILLED") return "FILLED";
    if (status === "CANCELLED" || status === "CANCELED") return "CANCELED";
    if (status === "INACTIVE" || status === "REJECTED") return "REJECTED";
    if (filledQuantity > 0 && remainingQuantity > 0) return "PARTIALLY_FILLED";
    if (status === "API_PENDING" || status === "PENDING_SUBMIT") return "PENDING";
    if (status !== undefined && IBKR_WORKING_STATUSES.has(status)) return "WORKING";
    return "UNKNOWN";
  }

  private canonicalIbkrOrderStatus(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    return value
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/\s+/g, "_")
      .toUpperCase();
  }

  private normalizeComboPreview(
    accountId: string,
    diagnostics: SafeTradingDiagnostics,
    response: IbkrWhatIfResponse
  ): DerivativeComboPreviewResult {
    const commission = this.whatIfNumber(response.amount?.commission);
    const initialMargin = this.whatIfMargin(response.initial);
    const maintenanceMargin = this.whatIfMargin(response.maintenance);
    const warnings = response.warn?.trim() ? [response.warn.trim()] : [];
    const rejectionReasons = response.error?.trim() ? [response.error.trim()] : [];
    if (
      rejectionReasons.length === 0 &&
      (commission === null || initialMargin === null || maintenanceMargin === null)
    ) {
      rejectionReasons.push("IBKR returned an incomplete What-If result");
    }
    return {
      accountId,
      environment: diagnostics.environment,
      accepted: rejectionReasons.length === 0,
      submitted: false,
      commission,
      initialMargin,
      maintenanceMargin,
      warnings,
      rejectionReasons,
      advisoryAssetPermissions: diagnostics.advisoryAssetPermissions,
    };
  }

  private whatIfMargin(
    value: { current?: string; change?: string; after?: string } | undefined
  ): { current: number; change: number; after: number } | null {
    const current = this.whatIfNumber(value?.current);
    const change = this.whatIfNumber(value?.change);
    const after = this.whatIfNumber(value?.after);
    return current === null || change === null || after === null
      ? null
      : { current, change, after };
  }

  private whatIfNumber(value: string | undefined): number | null {
    if (value === undefined) return null;
    const match = /[-+]?\d[\d,]*(?:\.\d+)?/.exec(value);
    if (match === null) return null;
    const parsed = Number(match[0].replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private withAccountCriticalSection<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = this.accountCriticalSectionTail.then(async () => {
      this.assertOpen();
      return operation();
    });
    this.accountCriticalSectionTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private withTradingMutation<T>(
    accountId: string,
    unsafeMessage: string,
    operation: (diagnostics: SafeTradingDiagnostics) => Promise<T>
  ): Promise<T> {
    return this.withAccountCriticalSection(async () => {
      const diagnostics = await this.getTradingDiagnostics(accountId);
      if (!this.isSafeForTradingMutation(diagnostics)) throw new Error(unsafeMessage);
      await this.prepareBrokerageAccount(accountId);
      return operation(diagnostics);
    });
  }

  private isSafeForTradingMutation(
    diagnostics: TradingDiagnostics
  ): diagnostics is SafeTradingDiagnostics {
    return (
      diagnostics.authenticated === true &&
      diagnostics.connected === true &&
      diagnostics.competingSession === false &&
      diagnostics.environment !== null
    );
  }

  private assertOpen(): void {
    if (this.closed) throw this.closedError();
  }

  private closedError(): Error {
    return new Error("This IBKR client is closed");
  }

  private booleanOrNull(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
  }

  private accountIdsOrNull(value: unknown): readonly string[] | null {
    return Array.isArray(value) &&
      Array.from(value).every((accountId) => typeof accountId === "string")
      ? value
      : null;
  }

  private async prepareBrokerageAccount(accountId: string): Promise<void> {
    const rawBrokerageAccounts = await this.req<unknown>({
      path: "iserver/accounts",
    });
    const brokerageAccounts = isUnknownRecord(rawBrokerageAccounts) ? rawBrokerageAccounts : {};
    const accountIds = this.accountIdsOrNull(brokerageAccounts["accounts"]);
    if (!accountIds?.includes(accountId)) {
      throw new Error(`IBKR account ${accountId} is not available for trading/order queries.`);
    }
    if (brokerageAccounts["selectedAccount"] === accountId) return;
    const switchedAccount = await this.singleAttemptRequest<IbkrSwitchAccountResponse>({
      path: "iserver/account",
      method: "POST",
      data: { acctId: accountId },
    });
    if (switchedAccount.set !== true || switchedAccount.acctId !== accountId) {
      throw new Error(`IBKR account switch was not confirmed for ${accountId}.`);
    }
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

  /**
   * Resolve a plain symbol to the one contract its quote may describe.
   *
   * The tradable underlying is the contract that lists options on SMART - the same evidence the
   * price-history path uses - so an index root such as `SPX` resolves to the CBOE index. The
   * first `trsrv/stocks` row is not authoritative: that endpoint is equity-only and returns
   * foreign listings that share the ticker (`SPX` matches an Australian mining stock), and a
   * snapshot taken from one of them reports a wrong price under the requested symbol. Stock
   * search therefore serves only symbols that list no SMART options, and only when it names
   * exactly one contract.
   *
   * A symbol that stays ambiguous resolves to no contract, so `getQuotes` omits it instead of
   * reporting a plausible wrong price.
   */
  private async resolveQuoteContract(symbol: string): Promise<QuoteContract | undefined> {
    const osi = parseOsiOptionSymbol(symbol);
    if (osi) {
      // The OSI root names the listing class, which is the underlying only for a single-class
      // name. It is passed as both: as the search root, which is all IBKR can be asked for here,
      // and as the class, so a month that lists more than one class resolves to the one this
      // symbol names instead of refusing. A caller holding a class-rooted symbol whose class IBKR
      // does not resolve as a root must quote by `brokerId` (the conid) instead.
      const option = await this.resolveOptionContract({
        symbol: osi.root,
        expiry: osi.expiry,
        strike: osi.strike,
        right: osi.right,
        tradingClass: osi.root,
      });
      return option
        ? {
            requestedSymbol: symbol,
            symbol: option.symbol,
            conid: option.conid,
          }
        : undefined;
    }
    const requestedSymbol = symbol.trim().toUpperCase();
    if (!requestedSymbol) return undefined;

    const search = await this.searchSecdef({ symbol: requestedSymbol });
    const optionable = smartOptionListings(secdefListings(search, requestedSymbol, "OPT"));
    if (optionable.length > 1) return undefined;
    const [optionableListing] = optionable;
    if (optionableListing !== undefined) {
      return { requestedSymbol: symbol, symbol: requestedSymbol, conid: optionableListing.conid };
    }

    // `trsrv/stocks` is equity/ETF-only, so a symbol with no SMART options can still be a plain
    // stock or ETF that the security-definition search does not describe as optionable.
    const stock = this.uniqueStockQuoteContract(symbol, await this.searchInstruments(symbol));
    if (stock !== undefined) return stock;

    // Non-stock roots without listed SMART options (indexes, futures) keep resolving from the
    // security-definition search that is already in hand.
    const nonStock = this.quoteContractConids(requestedSymbol, search, (item) =>
      (item.sections ?? []).some((section) => {
        const secType = section.secType?.trim().toUpperCase();
        return secType !== undefined && secType !== "" && secType !== "STK";
      })
    );
    if (nonStock.length !== 1) return undefined;
    const [fallbackConid] = nonStock;
    if (fallbackConid === undefined) return undefined;

    return { requestedSymbol: symbol, symbol: requestedSymbol, conid: fallbackConid };
  }

  /** Distinct conids that the security-definition search reports for one exact symbol. */
  private quoteContractConids(
    requestedSymbol: string,
    search: readonly IbkrSecdefSearchResult[],
    matches: (item: IbkrSecdefSearchResult) => boolean
  ): number[] {
    return [
      ...new Set(
        search.flatMap((item): number[] => {
          const conid = this.quoteConid(item.conid);
          return item.symbol?.trim().toUpperCase() === requestedSymbol &&
            conid !== undefined &&
            matches(item)
            ? [conid]
            : [];
        })
      ),
    ];
  }

  /** The one `trsrv/stocks` contract for a symbol, or nothing when the search is ambiguous. */
  private uniqueStockQuoteContract(
    symbol: string,
    instruments: readonly BrokerInstrument[]
  ): QuoteContract | undefined {
    const listed = instruments.filter((item) => this.quoteConid(item.brokerId) !== undefined);
    if (new Set(listed.map((item) => item.brokerId)).size !== 1) return undefined;
    const instrument = listed[0];
    const conid = this.quoteConid(instrument?.brokerId);
    if (instrument === undefined || conid === undefined) return undefined;
    return {
      requestedSymbol: symbol,
      symbol: instrument.symbol ?? symbol.trim().toUpperCase(),
      conid,
      ...(instrument.description !== undefined ? { description: instrument.description } : {}),
      ...(instrument.exchange !== undefined ? { exchange: instrument.exchange } : {}),
    };
  }

  /** A positive IBKR contract id, or nothing when the provider value is not usable. */
  private quoteConid(value: unknown): number | undefined {
    if (typeof value !== "number" && typeof value !== "string") return undefined;
    const conid = Number(value);
    return Number.isSafeInteger(conid) && conid > 0 ? conid : undefined;
  }

  /** Return complete daily history with the exact validated IBKR request context. */
  async getPriceHistory(input: PriceHistoryRequest): Promise<PriceHistoryResult> {
    this.assertOpen();
    const requestedSymbol = input.symbol.trim().toUpperCase();
    if (!requestedSymbol) {
      throw new IbkrPriceHistoryContractError(
        "Price history requires a symbol",
        "CONTRACT_INVALID"
      );
    }
    const interval = this.historyInterval(input);
    const period = `${String(interval.days)}d`;
    const contract =
      input.contract === undefined
        ? await this.resolveSymbolPriceHistoryContract(requestedSymbol)
        : await this.resolvePriceHistoryContract(requestedSymbol, input.contract);
    const request = {
      period,
      ...(input.endDate === undefined ? {} : { startTime: this.historyStartTime(interval.end) }),
    };
    let bars: PriceHistoryBar[];
    try {
      const history = await this.requestPriceHistory(contract, requestedSymbol, request);
      bars = this.normalizeHistoryResponse(requestedSymbol, history, interval);
      this.assertHistoryCoverage(requestedSymbol, bars, interval);
    } catch (error) {
      if (!this.isChartDataUnavailable(error)) throw error;
      bars = await this.recoverDailyHistory(contract, requestedSymbol, interval, error);
    }
    return {
      bars,
      contract,
      request: { requestedSymbol, period, barSize: "1d" },
    };
  }

  private resolveSymbolPriceHistoryContract(symbol: string): Promise<PriceHistoryContract> {
    const cached = this.priceHistoryContractResolution.get(symbol);
    if (cached !== undefined) return cached;
    const pending = this.resolvePriceHistoryContract(symbol, undefined).catch((error: unknown) => {
      if (this.priceHistoryContractResolution.get(symbol) === pending) {
        this.priceHistoryContractResolution.delete(symbol);
      }
      throw error;
    });
    this.priceHistoryContractResolution.set(symbol, pending);
    return pending;
  }

  private async resolvePriceHistoryContract(
    requestedSymbol: string,
    selector: PriceHistoryRequest["contract"]
  ): Promise<PriceHistoryContract> {
    if (selector !== undefined) {
      if (!Number.isSafeInteger(selector.conid) || selector.conid <= 0) {
        throw new IbkrPriceHistoryContractError(
          `Invalid IBKR price-history conid: ${String(selector.conid)}`,
          "CONTRACT_INVALID"
        );
      }
      const expectedSecurityType = selector.assetClass?.trim().toUpperCase();
      if (expectedSecurityType !== undefined && !isPriceHistorySecurityType(expectedSecurityType)) {
        throw new IbkrPriceHistoryContractError(
          `Invalid IBKR price-history asset class: ${expectedSecurityType}`,
          "CONTRACT_INVALID"
        );
      }
      return this.validatePriceHistoryContract(requestedSymbol, selector.conid, {
        ...(expectedSecurityType === undefined ? {} : { securityType: expectedSecurityType }),
        ...(selector.exchange === undefined
          ? {}
          : { exchange: selector.exchange.trim().toUpperCase() }),
      });
    }

    const search = await this.searchSecdef({ symbol: requestedSymbol });
    const smartOptionConids = new Set(
      smartOptionListings(secdefListings(search, requestedSymbol, "OPT")).map(
        (listing) => listing.conid
      )
    );
    const candidates = search.flatMap((item): PriceHistoryCandidate[] => {
      const symbol = item.symbol?.trim().toUpperCase();
      const conid = Number(item.conid);
      if (
        symbol !== requestedSymbol ||
        !Number.isSafeInteger(conid) ||
        conid <= 0 ||
        !Array.isArray(item.sections)
      ) {
        return [];
      }
      return item.sections.flatMap((section): PriceHistoryCandidate[] => {
        const securityType = section.secType?.trim().toUpperCase();
        if (securityType !== "STK" && securityType !== "IND") return [];
        const exchange = section.exchange?.trim().toUpperCase();
        return [
          {
            conid,
            symbol,
            securityType,
            ...(exchange ? { exchange } : {}),
            supportsSmartOptions: smartOptionConids.has(conid),
          },
        ];
      });
    });
    const uniqueCandidates = [
      ...new Map(
        [...candidates]
          .sort((left, right) => (left.exchange ?? "").localeCompare(right.exchange ?? ""))
          .map((candidate) => [[candidate.conid, candidate.securityType].join(":"), candidate])
      ).values(),
    ];
    if (uniqueCandidates.length === 0) {
      throw new IbkrPriceHistoryContractError(
        `IBKR returned no STK or IND contract for ${requestedSymbol}`,
        "CONTRACT_NOT_FOUND"
      );
    }
    const smartCandidates = uniqueCandidates.filter((candidate) => candidate.supportsSmartOptions);
    if (smartCandidates.length !== 1) {
      const safeCandidates = uniqueCandidates.map((candidate) => ({
        conid: candidate.conid,
        symbol: candidate.symbol,
        securityType: candidate.securityType,
        exchange: candidate.exchange ?? null,
      }));
      const isMissing = smartCandidates.length === 0;
      throw new IbkrPriceHistoryContractError(
        `IBKR price-history SMART option underlying is ${isMissing ? "missing" : "ambiguous"} for ${requestedSymbol}; specify contract.conid`,
        isMissing ? "CONTRACT_NOT_FOUND" : "CONTRACT_AMBIGUOUS",
        safeCandidates
      );
    }
    const candidate = smartCandidates[0];
    if (candidate === undefined) {
      throw new Error("IBKR price-history resolution lost its selected contract");
    }
    return this.validatePriceHistoryContract(requestedSymbol, candidate.conid, {
      securityType: candidate.securityType,
    });
  }

  private async validatePriceHistoryContract(
    requestedSymbol: string,
    conid: number,
    expected: { securityType?: PriceHistorySecurityType; exchange?: string }
  ): Promise<PriceHistoryContract> {
    const response = await this.req<unknown>({
      path: `iserver/contract/${String(conid)}/info`,
    });
    if (
      isUnknownRecord(response) &&
      response["error"] !== undefined &&
      response["error"] !== null
    ) {
      const detail = this.normalizeBrokerError(
        response["error"],
        response,
        "IBKR rejected the contract metadata request"
      );
      throw new IbkrBrokerResponseError(detail.message, detail);
    }
    if (!isUnknownRecord(response)) {
      throw new IbkrPriceHistoryContractError(
        `IBKR returned malformed contract metadata for conid ${String(conid)}`,
        "CONTRACT_INVALID"
      );
    }
    const info = response as IbkrContractInfo;
    const returnedConid = Number(info.con_id);
    const symbol = info.local_symbol?.trim().toUpperCase();
    const securityType = info.instrument_type?.trim().toUpperCase();
    const exchange = info.exchange?.trim().toUpperCase();
    if (
      returnedConid !== conid ||
      symbol === undefined ||
      !symbol ||
      securityType === undefined ||
      !isPriceHistorySecurityType(securityType) ||
      exchange === undefined ||
      !exchange
    ) {
      throw new IbkrPriceHistoryContractError(
        `IBKR returned incomplete contract metadata for conid ${String(conid)}`,
        "CONTRACT_INVALID"
      );
    }
    const contract = { conid, symbol, securityType, exchange };
    if (
      symbol !== requestedSymbol ||
      (expected.securityType !== undefined && expected.securityType !== securityType) ||
      (expected.exchange !== undefined && expected.exchange !== exchange)
    ) {
      throw new IbkrPriceHistoryContractError(
        `IBKR contract ${String(conid)} does not match the requested price-history identity`,
        "CONTRACT_MISMATCH",
        [contract]
      );
    }
    return contract;
  }

  /** Discover listed derivative series over an inclusive calendar range. */
  async getDerivativeExpiries(query: DerivativeExpiryQuery): Promise<DerivativeExpiry[]> {
    this.assertOpen();
    const contracts: DerivativeContract[] = [];
    for (const month of monthCodes(query.from, query.to)) {
      contracts.push(
        ...(await this.discoverDerivativeMonth(
          query.underlying,
          query.assetClass,
          month,
          query.exchange,
          query.right
        ))
      );
    }
    const filtered = contracts.filter(
      (contract) =>
        contract.expiration >= query.from &&
        contract.expiration <= query.to &&
        (query.right === undefined || contract.right === query.right) &&
        (query.tradingClass === undefined ||
          contract.tradingClass === query.tradingClass.trim().toUpperCase())
    );
    const expiries = filtered.map(
      ({ assetClass, underlying, expiration, tradingClass, exchange, multiplier }) => ({
        assetClass,
        underlying,
        expiration,
        tradingClass,
        exchange,
        multiplier,
      })
    );
    return [
      ...new Map(
        expiries.map((expiry) => [
          [
            expiry.assetClass,
            expiry.underlying,
            expiry.expiration,
            expiry.tradingClass,
            expiry.exchange,
            String(expiry.multiplier),
          ].join(":"),
          expiry,
        ])
      ).values(),
    ].sort((left, right) => left.expiration.localeCompare(right.expiration));
  }

  /** Discover contracts for one exact expiration, preserving class and venue identity. */
  async getDerivativeContracts(query: DerivativeContractQuery): Promise<DerivativeContract[]> {
    this.assertOpen();
    const tradingClass = query.tradingClass?.trim().toUpperCase();
    return (
      await this.discoverDerivativeMonth(
        query.underlying,
        query.assetClass,
        monthCode(query.expiration),
        query.exchange,
        query.right,
        query.strike
      )
    ).filter(
      (contract) =>
        contract.expiration === query.expiration &&
        (query.right === undefined || contract.right === query.right) &&
        (query.strike === undefined || contract.strike === query.strike) &&
        (tradingClass === undefined || contract.tradingClass === tradingClass)
    );
  }

  /** Resolve exactly one contract and reject missing or ambiguous semantic identity. */
  async resolveDerivativeContract(
    query: DerivativeContractQuery & { right: OptionRight; strike: number }
  ): Promise<DerivativeContract> {
    this.assertOpen();
    const contracts = await this.getDerivativeContracts(query);
    if (!contracts.length) {
      throw new Error(
        `IBKR returned no exact ${query.assetClass} contract for ${query.underlying} ${query.expiration} ${query.right}${String(query.strike)}`
      );
    }
    if (contracts.length !== 1) {
      const classes = [...new Set(contracts.map((contract) => contract.tradingClass))].join(", ");
      throw new Error(
        `Ambiguous ${query.assetClass} contract for ${query.underlying} ${query.expiration} ${query.right}${String(query.strike)}; specify tradingClass (${classes})`
      );
    }
    const contract = contracts[0];
    if (!contract) throw new Error("IBKR exact derivative resolution lost its selected contract");
    return contract;
  }

  /** Return an exact-expiration derivative chain with explicit data availability. */
  async getDerivativeChain(query: DerivativeContractQuery): Promise<DerivativeQuote[]> {
    this.assertOpen();
    const contracts = await this.getDerivativeContracts(query);
    if (!contracts.length) {
      throw new Error(
        `IBKR returned no ${query.assetClass} contracts for ${query.underlying} ${query.expiration}`
      );
    }
    const quotes = await this.fetchDerivativeQuotes(contracts);
    if (!quotes.some((quote) => quote.bid !== null && quote.ask !== null)) {
      throw new Error(
        `IBKR returned no usable derivative quotes for ${query.underlying} ${query.expiration}`
      );
    }
    return quotes;
  }

  /** Quote the broker-linked underlying (for example, the Sep NQ future behind QN3). */
  async getDerivativeReferenceQuote(
    contract: DerivativeContract
  ): Promise<DerivativeReferenceQuote> {
    this.assertOpen();
    const detailResponse = await this.req<IbkrSecdefResponse>({
      path: "trsrv/secdef",
      params: { conids: String(contract.conid) },
    });
    const details = (detailResponse.secdef ?? []).filter(
      (detail) => detail.conid === contract.conid
    );
    if (details.length !== 1) {
      throw new Error(
        `IBKR returned ${String(details.length)} contract details for derivative ${String(contract.conid)}`
      );
    }
    const detail = details[0];
    const referenceConid = detail?.undConid;
    if (
      !Number.isSafeInteger(referenceConid) ||
      referenceConid === undefined ||
      referenceConid <= 0
    ) {
      throw new Error(
        `IBKR did not identify the underlying contract for derivative ${String(contract.conid)}`
      );
    }
    const params = {
      conids: String(referenceConid),
      fields: DERIVATIVE_REFERENCE_QUOTE_FIELDS,
    };
    await this.req<unknown>({ path: "iserver/marketdata/snapshot", params });
    await this.wait(2000);
    const snapshots = await this.req<IbkrMarketDataSnapshot[]>({
      path: "iserver/marketdata/snapshot",
      params,
    });
    const snapshot = snapshots.find((item) => item.conid === referenceConid);
    const bid = snapshot ? (this.snapshotNumber(snapshot, "84") ?? null) : null;
    const ask = snapshot ? (this.snapshotNumber(snapshot, "86") ?? null) : null;
    const suppliedMark = snapshot ? (this.snapshotNumber(snapshot, "7635") ?? null) : null;
    const trade = snapshot
      ? this.snapshotTradePrice(snapshot)
      : { last: undefined, close: undefined };
    return {
      conid: referenceConid,
      symbol: String(snapshot?.["55"] ?? detail?.undSym ?? contract.underlying),
      availability: normalizeDerivativeDataAvailability(snapshot?.["6509"]),
      timestamp: snapshot ? this.snapshotTimestamp(snapshot) : null,
      bid,
      ask,
      last: trade.last ?? null,
      close: trade.close ?? null,
      mark: suppliedMark ?? (bid !== null && ask !== null ? (bid + ask) / 2 : null),
    };
  }

  /** Discover every listed weekly/monthly expiry in the requested calendar range. */
  async getOptionExpiries(
    symbol: string,
    right: OptionRight,
    fromDate: string,
    toDate: string,
    options: OptionDiscoveryOptions = {}
  ): Promise<string[]> {
    this.assertOpen();
    const normalized = symbol.trim().toUpperCase();
    const months = monthCodes(fromDate, toDate);
    const contracts: OptionContract[] = [];
    for (const month of months) {
      const result = await this.discoverOptions(normalized, month, right, options);
      contracts.push(...result.contracts);
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
  async getOptionChain(
    symbol: string,
    expiry: string,
    right?: OptionRight,
    options: OptionDiscoveryOptions = {}
  ): Promise<OptionMarketQuote[]> {
    this.assertOpen();
    const month = monthCode(expiry);
    const normalized = symbol.trim().toUpperCase();
    const discovery = await this.discoverOptions(normalized, month, right, options);
    const contracts = discovery.contracts.filter(
      (contract) => contract.expiry === expiry && (right === undefined || contract.right === right)
    );
    if (!contracts.length) {
      throw new Error(`IBKR returned no option contracts for ${symbol} ${expiry}`);
    }
    const quoted = await this.fetchOptionQuotes(contracts, {
      allowIncomplete: true,
      telemetry: { symbol: normalized, month, right: right ?? null },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!quoted.length) {
      throw new Error(`IBKR returned no usable option quotes for ${symbol} ${expiry}`);
    }
    return quoted;
  }

  /** Return every qualified contract for one exact expiry and side without hiding sparse data. */
  async getOptionChainSnapshot(
    symbol: string,
    expiry: string,
    right: OptionRight,
    options: OptionDiscoveryOptions = {}
  ): Promise<OptionChainSnapshot> {
    this.assertOpen();
    const month = monthCode(expiry);
    const normalized = symbol.trim().toUpperCase();
    const discovery = await this.discoverOptions(normalized, month, right, options);
    const contracts = discovery.contracts.filter((contract) => contract.expiry === expiry);
    if (!contracts.length) {
      throw new Error(`IBKR returned no ${right} option contracts for ${symbol} ${expiry}`);
    }
    return this.fetchOptionChainSnapshot(
      contracts,
      discovery.malformedDefinitionCount,
      { symbol: normalized, month, right },
      options.signal
    );
  }

  /** Fetch one exact option quote; null means the contract is not listed. */
  async getOptionQuote(input: OptionQuoteRequest): Promise<OptionMarketQuote | null> {
    this.assertOpen();
    const contract = await this.resolveOptionContract(input);
    if (!contract) return null;
    return (await this.fetchOptionQuotes([contract]))[0] ?? null;
  }

  /** Resolve a conid back into the canonical OSI-bearing option contract. */
  async getOptionContract(conid: number): Promise<OptionContract | null> {
    this.assertOpen();
    const response = await this.req<IbkrSecdefByConidResponse>({
      path: "trsrv/secdef",
      params: { conids: String(conid) },
    });
    // IBKR answers with `{ secdef: [contract] }`; the keyed-by-conid shape is kept for gateway
    // builds that still answer that way. An entry that names a different conid is not evidence
    // about this one, so it is ignored rather than trusted.
    const keyed = response[String(conid)];
    const candidates = [
      ...(Array.isArray(response.secdef) ? response.secdef : []),
      ...(Array.isArray(keyed) ? keyed : keyed === undefined ? [] : [keyed]),
    ];
    const raw = candidates.find(
      (candidate) => candidate.conid === undefined || candidate.conid === conid
    );
    if (!raw) return null;
    return normalizeOptionContract({
      conid: raw.conid ?? conid,
      // `symbol` is absent on this payload; IBKR names the underlying `undSym` and the listing
      // class `ticker` here. `ticker` is the class - `SPXW` where `undSym` is `SPX` - so it is the
      // trading class, and the underlying falls back to it for a single-listing name.
      symbol: raw.undSym ?? raw.symbol ?? raw.ticker,
      tradingClass: raw.tradingClass ?? raw.ticker,
      maturityDate: raw.expiry ?? raw.maturityDate,
      right: raw.putOrCall,
      strike: raw.strike,
    });
  }

  private resolveOptionContract(input: OptionQuoteRequest): Promise<OptionContract | null> {
    const underlying = input.symbol.trim().toUpperCase();
    const month = monthCode(input.expiry);
    const key = [
      underlying,
      input.expiry,
      String(input.strike),
      input.right,
      input.tradingClass?.trim().toUpperCase() ?? "*",
    ].join(":");
    let pending = this.optionContractResolution.get(key);
    if (!pending) {
      pending = this.loadExactOptionContract({ ...input, symbol: underlying }, month).then(
        (contract) => {
          if (contract === null) this.optionContractResolution.delete(key);
          return contract;
        },
        (error: unknown) => {
          this.optionContractResolution.delete(key);
          throw error;
        }
      );
      this.optionContractResolution.set(key, pending);
    }
    return pending;
  }

  /** Resolve one known option directly, without enumerating its month's complete chain. */
  private loadExactOptionContract(
    input: OptionQuoteRequest,
    month: string
  ): Promise<OptionContract | null> {
    return this.withSecdefPriming(() => this.loadExactOptionContractPrimed(input, month));
  }

  private async loadExactOptionContractPrimed(
    input: OptionQuoteRequest,
    month: string
  ): Promise<OptionContract | null> {
    const underlying = await this.loadOptionUnderlying(input.symbol);
    const definitions = await this.req<unknown>({
      path: "iserver/secdef/info",
      params: {
        conid: String(underlying.conid),
        sectype: "OPT",
        month,
        strike: input.strike,
        right: input.right,
      },
    });
    if (!Array.isArray(definitions)) {
      throw new Error(`IBKR returned malformed option definitions for ${input.symbol} ${month}`);
    }
    const matches: OptionContract[] = [];
    let malformed = false;
    for (const raw of definitions) {
      if (!isUnknownRecord(raw)) {
        malformed = true;
        continue;
      }
      const rawConid = raw["conid"];
      const rawSymbol = raw["symbol"];
      const rawTradingClass = raw["tradingClass"];
      const rawMaturityDate = raw["maturityDate"];
      const rawRight = raw["right"];
      const rawStrike = raw["strike"];
      const rawSecType = raw["secType"];
      let contract: OptionContract | null;
      try {
        contract = normalizeOptionContract({
          conid: typeof rawConid === "number" ? rawConid : undefined,
          symbol: typeof rawSymbol === "string" ? rawSymbol : underlying.symbol,
          tradingClass: typeof rawTradingClass === "string" ? rawTradingClass : undefined,
          maturityDate: typeof rawMaturityDate === "string" ? rawMaturityDate : undefined,
          right: typeof rawRight === "string" ? rawRight : undefined,
          strike:
            typeof rawStrike === "string" || typeof rawStrike === "number" ? rawStrike : undefined,
        });
      } catch {
        contract = null;
      }
      if (
        contract === null ||
        (rawSecType !== undefined &&
          (typeof rawSecType !== "string" || rawSecType.toUpperCase() !== "OPT"))
      ) {
        malformed = true;
        continue;
      }
      const requestedClass = input.tradingClass?.trim().toUpperCase();
      // A caller reaches this with either a plain underlying or an OSI root that names a class, so
      // both are accepted as the requested root. The class filter below is what keeps two listings
      // apart; without it, an underlying that lists two classes still refuses rather than guesses.
      const rootMatches =
        contract.underlying === input.symbol || contract.tradingClass === input.symbol;
      if (
        rootMatches &&
        contract.expiry === input.expiry &&
        contract.right === input.right &&
        contract.strike === input.strike &&
        (requestedClass === undefined ||
          contract.tradingClass === requestedClass ||
          // A contract with no stated class answers a request for its own underlying root, which
          // is what a single-listing name asks for. It never answers for another class.
          (contract.tradingClass === null && contract.underlying === requestedClass))
      ) {
        matches.push(contract);
      }
    }
    if (malformed) {
      throw new Error(`IBKR returned malformed option definitions for ${input.symbol} ${month}`);
    }
    const unique = [...new Map(matches.map((contract) => [contract.conid, contract])).values()];
    if (unique.length > 1) {
      // Two listing classes of one underlying are two products, and the caller must say which one
      // it means. Two contracts inside one class are a collision the client cannot resolve; both
      // stay a refusal rather than a guess.
      const classes = [
        ...new Set(unique.map((contract) => contract.tradingClass ?? contract.underlying)),
      ].sort();
      const detail =
        classes.length > 1
          ? `; listing classes: ${classes.join(", ")}. Name one in 'tradingClass'.`
          : "";
      throw new Error(
        `IBKR returned ambiguous option definitions for ${input.symbol} ${input.expiry}${detail}`
      );
    }
    return unique[0] ?? null;
  }

  private discoverDerivativeMonth(
    underlying: string,
    assetClass: DerivativeAssetClass,
    month: string,
    exchange?: string,
    right?: OptionRight,
    strike?: number
  ): Promise<DerivativeContract[]> {
    const normalizedUnderlying = underlying.trim().toUpperCase();
    if (!normalizedUnderlying) throw new Error("Derivative underlying is required");
    const normalizedExchange = exchange?.trim().toUpperCase();
    const key = [
      normalizedUnderlying,
      assetClass,
      month,
      normalizedExchange ?? "*",
      right ?? "*",
      strike === undefined ? "*" : String(strike),
    ].join(":");
    let pending = this.derivativeDiscovery.get(key);
    if (!pending) {
      pending = this.loadDerivativeContracts(
        normalizedUnderlying,
        assetClass,
        month,
        normalizedExchange,
        right,
        strike
      );
      this.derivativeDiscovery.set(key, pending);
    }
    return pending;
  }

  private loadDerivativeContracts(
    underlying: string,
    assetClass: DerivativeAssetClass,
    month: string,
    requestedExchange?: string,
    requestedRight?: OptionRight,
    requestedStrike?: number
  ): Promise<DerivativeContract[]> {
    return this.withSecdefPriming(() =>
      this.loadDerivativeContractsPrimed(
        underlying,
        assetClass,
        month,
        requestedExchange,
        requestedRight,
        requestedStrike
      )
    );
  }

  private async loadDerivativeContractsPrimed(
    underlying: string,
    assetClass: DerivativeAssetClass,
    month: string,
    requestedExchange?: string,
    requestedRight?: OptionRight,
    requestedStrike?: number
  ): Promise<DerivativeContract[]> {
    // IBKR keeps this priming state in the authenticated session. Strikes may be
    // empty when search has not run first, even with otherwise identical params.
    const search = this.parseSecdefSearchResponse(
      await this.req<unknown>({
        path: "iserver/secdef/search",
        params: { symbol: underlying, ...(assetClass === "FOP" ? { secType: "FUT" } : {}) },
      })
    );
    // Order placement resolves its legs through here, so it narrows the search exactly as option
    // discovery does. Without it a ticker that also names a Canadian Depositary Receipt, such as
    // `UNH` or `NFLX`, refuses every order for a listing it does not trade (#671).
    const listings = secdefListings(search, underlying, assetClass);
    const candidates = preferSmartOptionListings(listings);
    if (candidates.length !== 1) {
      const detail =
        candidates.length > 1 ? `; competing listings: ${describeSecdefListings(candidates)}` : "";
      throw new Error(
        `IBKR ${assetClass} underlying identity is ${candidates.length ? "ambiguous" : "missing"} for ${underlying}${detail}`
      );
    }
    const candidate = candidates[0];
    if (!candidate) throw new Error(`IBKR lost the selected underlying for ${underlying}`);
    const conid = candidate.conid;
    const exchanges = candidate.exchanges;
    if (requestedExchange && !exchanges.includes(requestedExchange)) {
      throw new Error(
        `IBKR does not list ${underlying} ${assetClass} discovery on ${requestedExchange}`
      );
    }
    const exchange = requestedExchange ?? (exchanges.length === 1 ? exchanges[0] : undefined);

    const strikes = await this.req<IbkrSecdefStrikesResponse>({
      path: "iserver/secdef/strikes",
      params: {
        conid: String(conid),
        sectype: assetClass,
        month,
        ...(exchange ? { exchange } : {}),
      },
    });
    const availableRequests = [
      ...(strikes.call ?? []).map((strike) => ({ strike, right: "C" as const })),
      ...(strikes.put ?? []).map((strike) => ({ strike, right: "P" as const })),
    ];
    if (!availableRequests.length) {
      throw new Error(
        `IBKR returned empty ${assetClass} strikes for ${underlying} ${month} after secdef/search priming`
      );
    }
    const requests = availableRequests.filter(
      (request) =>
        (requestedRight === undefined || request.right === requestedRight) &&
        (requestedStrike === undefined || request.strike === requestedStrike)
    );
    if (!requests.length) {
      return [];
    }

    const contracts: DerivativeContract[] = [];
    for (const batch of chunks(requests, OPTION_SECDEF_INFO_BATCH_SIZE)) {
      const responses = await Promise.all(
        batch.map(({ strike, right }) =>
          this.req<IbkrSecdefInfo[]>({
            path: "iserver/secdef/info",
            params: {
              conid: String(conid),
              sectype: assetClass,
              month,
              strike,
              right,
              ...(exchange ? { exchange } : {}),
            },
          })
        )
      );
      for (const raw of responses.flat()) {
        const contract = normalizeDerivativeContract(raw, assetClass, underlying);
        if (contract && (!requestedExchange || contract.exchange === requestedExchange)) {
          contracts.push(contract);
        }
      }
    }
    const unique = [...new Map(contracts.map((contract) => [contract.conid, contract])).values()];
    if (!unique.length) {
      throw new Error(
        `IBKR returned no usable ${assetClass} definitions for ${underlying} ${month}`
      );
    }
    return unique;
  }

  private async fetchDerivativeQuotes(
    contracts: readonly DerivativeContract[]
  ): Promise<DerivativeQuote[]> {
    const result: DerivativeQuote[] = [];
    for (const batch of chunks(contracts, OPTION_MARKETDATA_BATCH_SIZE)) {
      const params = {
        conids: batch.map((contract) => contract.conid).join(","),
        fields: DERIVATIVE_QUOTE_FIELDS,
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
        const trade = snapshot
          ? this.snapshotTradePrice(snapshot)
          : { last: undefined, close: undefined };
        result.push({
          contract,
          availability: normalizeDerivativeDataAvailability(snapshot?.["6509"]),
          timestamp: snapshot ? this.snapshotTimestamp(snapshot) : null,
          bid: snapshot ? (this.snapshotNumber(snapshot, "84") ?? null) : null,
          ask: snapshot ? (this.snapshotNumber(snapshot, "86") ?? null) : null,
          last: trade.last ?? null,
          close: trade.close ?? null,
          mark: snapshot ? (this.snapshotNumber(snapshot, "7635") ?? null) : null,
          delta: snapshot ? (this.snapshotNumber(snapshot, "7308") ?? null) : null,
          impliedVolatility: snapshot ? (this.snapshotNumber(snapshot, "7633") ?? null) : null,
          volume: snapshot ? (this.snapshotVolume(snapshot) ?? null) : null,
          openInterest: snapshot ? (this.snapshotNumber(snapshot, "7638") ?? null) : null,
        });
      }
    }
    return result;
  }

  private discoverOptions(
    symbol: string,
    month: string,
    right?: OptionRight,
    options: OptionDiscoveryOptions = {}
  ): Promise<OptionDiscoveryResult> {
    const normalized = symbol.trim().toUpperCase();
    const strikeRange = normalizeStrikeRange(options.strikeRange);
    const discoveryOptions = {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(strikeRange === undefined ? {} : { strikeRange }),
    };
    if (options.signal !== undefined) {
      return this.loadOptionContracts(normalized, month, right, discoveryOptions);
    }
    // The band belongs in the memo key. A narrowed result holds only part of the month, so it must
    // never answer a later request for a different band.
    const bandKey = strikeRangeKey(strikeRange);
    const key = `${normalized}:${month}:${right ?? "*"}:${bandKey}`;
    const cached = this.optionDiscovery.get(key);
    if (cached !== undefined) return cached;

    let discovery: Promise<OptionDiscoveryResult> | undefined;
    if (right !== undefined) {
      const complete = this.optionDiscovery.get(`${normalized}:${month}:*:${bandKey}`);
      if (complete !== undefined) {
        discovery = complete.then((result) => ({
          contracts: result.contracts.filter((contract) => contract.right === right),
          malformedDefinitionCount: result.malformedDefinitionCount,
        }));
      }
    }
    discovery ??= this.loadOptionContracts(normalized, month, right, discoveryOptions);
    const pending = discovery.catch((error: unknown) => {
      if (this.optionDiscovery.get(key) === pending) this.optionDiscovery.delete(key);
      throw error;
    });
    this.optionDiscovery.set(key, pending);
    return pending;
  }

  private async loadOptionUnderlying(
    symbol: string,
    signal?: AbortSignal
  ): Promise<OptionUnderlying> {
    // This search is load-bearing: IBKR silently returns empty definitions unless the current
    // session has first searched the underlying.
    const search = this.parseSecdefSearchResponse(
      await this.req<unknown>(
        {
          path: "iserver/secdef/search",
          params: { symbol },
        },
        signal
      )
    );
    const eligible = preferSmartOptionListings(secdefListings(search, symbol, "OPT"));
    if (eligible.length !== 1) {
      const detail =
        eligible.length > 1 ? `; competing listings: ${describeSecdefListings(eligible)}` : "";
      throw new Error(
        `IBKR option underlying identity is ${eligible.length ? "ambiguous" : "missing"} for ${symbol}${detail}`
      );
    }
    const [underlying] = eligible;
    if (underlying === undefined)
      throw new Error(`IBKR lost the selected underlying for ${symbol}`);
    return { conid: underlying.conid, symbol };
  }

  private async loadOptionContracts(
    symbol: string,
    month: string,
    right?: OptionRight,
    options: { signal?: AbortSignal; strikeRange?: OptionStrikeRange } = {}
  ): Promise<OptionDiscoveryResult> {
    const callerSignal = options.signal;
    const strikeRange = normalizeStrikeRange(options.strikeRange);
    const operation = new AbortController();
    const abortFromCaller = (): void => {
      operation.abort(callerSignal?.reason);
    };
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const { underlying, requests, listedStrikeCount } = await this.withSecdefPriming(async () => {
        const searchStarted = this.requestNow();
        const selectedUnderlying = await this.loadOptionUnderlying(symbol, operation.signal);
        this.emitOptionDiscoveryTelemetry({
          phase: "SEARCH",
          symbol,
          month,
          right: right ?? null,
          durationMs: this.elapsedSince(searchStarted),
        });

        const strikesStarted = this.requestNow();
        const strikes = await this.req<IbkrSecdefStrikesResponse>(
          {
            path: "iserver/secdef/strikes",
            params: { conid: String(selectedUnderlying.conid), sectype: "OPT", month },
          },
          operation.signal
        );
        const strikesDurationMs = this.elapsedSince(strikesStarted);
        const callStrikes = strikes.call ?? [];
        const putStrikes = strikes.put ?? [];
        if (callStrikes.length === 0 && putStrikes.length === 0) {
          throw new Error(
            `IBKR returned empty option strikes for ${symbol} ${month} after secdef/search priming`
          );
        }
        const listed = [
          ...(right === undefined || right === "C"
            ? callStrikes.map((strike) => ({ strike, right: "C" as const }))
            : []),
          ...(right === undefined || right === "P"
            ? putStrikes.map((strike) => ({ strike, right: "P" as const }))
            : []),
        ];
        // One security definition costs one paced request, so the band is applied here, before any
        // definition is requested. Applying it later would keep the full cost of the month.
        const selected = listed.filter(({ strike }) => strikeInRange(strike, strikeRange));
        this.emitOptionDiscoveryTelemetry({
          phase: "STRIKES",
          symbol,
          month,
          right: right ?? null,
          durationMs: strikesDurationMs,
          listedStrikeCount: listed.length,
          selectedStrikeCount: selected.length,
        });
        // A band that keeps nothing is a caller mistake, not an empty chain. Reporting it as an
        // empty result would look like an unlisted expiry.
        if (listed.length > 0 && selected.length === 0) {
          throw new Error(
            `IBKR option strike range [${String(strikeRange?.min ?? "-inf")}, ` +
              `${String(strikeRange?.max ?? "+inf")}] selected none of the ` +
              `${String(listed.length)} listed strikes for ${symbol} ${month}`
          );
        }
        return {
          underlying: selectedUnderlying,
          requests: selected,
          listedStrikeCount: listed.length,
        };
      });

      const definitionsStarted = this.requestNow();
      const contracts: OptionContract[] = [];
      let malformedDefinitionCount = 0;
      const cached = await this.readCachedOptionDefinitions(underlying.conid, month, requests);
      const pending: { strike: number; right: OptionRight }[] = [];
      let cachedDefinitionCount = 0;
      for (const [position, request] of requests.entries()) {
        const hit = cached[position];
        if (hit === undefined || hit === null) {
          pending.push(request);
          continue;
        }
        cachedDefinitionCount += 1;
        contracts.push(...hit);
      }
      const resolved: OptionDefinitionCacheEntry[] = [];
      for (const batch of chunks(pending, OPTION_SECDEF_INFO_BATCH_SIZE)) {
        let responses: unknown[];
        try {
          responses = await Promise.all(
            batch.map(({ strike, right: requestRight }) =>
              this.req<unknown>(
                {
                  path: "iserver/secdef/info",
                  params: {
                    conid: String(underlying.conid),
                    sectype: "OPT",
                    month,
                    strike,
                    right: requestRight,
                  },
                },
                operation.signal,
                (error) => {
                  operation.abort(error);
                }
              )
            )
          );
        } catch (error) {
          operation.abort(error);
          throw error;
        }

        for (const [position, response] of responses.entries()) {
          if (!Array.isArray(response)) {
            throw new Error(`IBKR returned malformed option definitions for ${symbol} ${month}`);
          }
          const request = batch[position];
          const resolvedForRequest: OptionContract[] = [];
          let requestHadMalformedRecord = false;
          for (const raw of response) {
            if (!isUnknownRecord(raw)) {
              malformedDefinitionCount += 1;
              requestHadMalformedRecord = true;
              continue;
            }
            let contract: OptionContract | null;
            try {
              contract = normalizeOptionContract({
                conid: typeof raw["conid"] === "number" ? raw["conid"] : undefined,
                symbol: typeof raw["symbol"] === "string" ? raw["symbol"] : underlying.symbol,
                tradingClass:
                  typeof raw["tradingClass"] === "string" ? raw["tradingClass"] : undefined,
                maturityDate:
                  typeof raw["maturityDate"] === "string" ? raw["maturityDate"] : undefined,
                right: typeof raw["right"] === "string" ? raw["right"] : undefined,
                strike:
                  typeof raw["strike"] === "string" || typeof raw["strike"] === "number"
                    ? raw["strike"]
                    : undefined,
              });
            } catch {
              malformedDefinitionCount += 1;
              requestHadMalformedRecord = true;
              continue;
            }
            if (contract) resolvedForRequest.push(contract);
            else {
              malformedDefinitionCount += 1;
              requestHadMalformedRecord = true;
            }
          }
          contracts.push(...resolvedForRequest);
          // A partial answer is never stored. A later run must ask the broker again rather than
          // read a record that already lost contracts.
          if (request !== undefined && !requestHadMalformedRecord) {
            resolved.push({
              key: {
                underlyingConid: underlying.conid,
                month,
                right: request.right,
                strike: request.strike,
              },
              contracts: resolvedForRequest,
            });
          }
        }
      }
      await this.writeCachedOptionDefinitions(resolved);
      this.emitOptionDiscoveryTelemetry({
        phase: "DEFINITIONS",
        symbol,
        month,
        right: right ?? null,
        durationMs: this.elapsedSince(definitionsStarted),
        definitionRequestCount: pending.length,
        listedStrikeCount,
        selectedStrikeCount: requests.length,
        cachedDefinitionCount,
      });
      if (requests.length === 0) return { contracts: [], malformedDefinitionCount: 0 };

      const unique = [...new Map(contracts.map((contract) => [contract.conid, contract])).values()];
      if (!unique.length) {
        throw new Error(
          `IBKR returned no usable option definitions for ${symbol} ${month} (${String(
            malformedDefinitionCount
          )} malformed)`
        );
      }
      // Two conids that reach one durable symbol are two contracts a consumer cannot tell apart.
      // This is the check that lets an unstated listing class fall back to the underlying root: a
      // fallback that would hide a collision is refused instead of returned.
      const collision = firstSymbolCollision(unique);
      if (collision !== null) {
        throw new Error(
          `IBKR returned two option contracts with one identity for ${symbol} ${month}: ` +
            `${collision.symbol} is conid ${String(collision.first.conid)} and ` +
            `${String(collision.second.conid)}. IBKR stated no listing class for at least one.`
        );
      }
      return { contracts: unique, malformedDefinitionCount };
    } finally {
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  /**
   * Read one definition for each request from the cache, aligned by index.
   *
   * Every failure mode collapses to "miss": no cache, a rejected read, a misaligned result, or a
   * record that is not a valid contract for the key it answers. The broker is then asked, so a bad
   * cache costs time and never changes an answer.
   */
  private async readCachedOptionDefinitions(
    underlyingConid: number,
    month: string,
    requests: readonly { strike: number; right: OptionRight }[]
  ): Promise<readonly (readonly OptionContract[] | null)[]> {
    const cache = this.optionDefinitionCache;
    if (cache === undefined || requests.length === 0) return requests.map(() => null);
    const keys: OptionDefinitionCacheKey[] = requests.map(({ strike, right }) => ({
      underlyingConid,
      month,
      right,
      strike,
    }));
    // The result is treated as untrusted data, not as the declared type. An implementation that
    // returns the wrong shape must degrade to a miss, never to a fabricated contract.
    let answer: unknown;
    try {
      answer = await cache.get(keys);
    } catch {
      return requests.map(() => null);
    }
    if (!Array.isArray(answer) || answer.length !== keys.length) return requests.map(() => null);
    const records: readonly unknown[] = answer;
    return keys.map((key, position) => {
      const record = records[position];
      if (record === null || record === undefined) return null;
      if (!Array.isArray(record)) return null;
      const cachedContracts: readonly unknown[] = record;
      if (!cachedContracts.every((contract) => isCachedOptionContract(contract, key))) return null;
      return cachedContracts as readonly OptionContract[];
    });
  }

  /** Store resolved definitions. A store failure is never fatal: the identity came from IBKR. */
  private async writeCachedOptionDefinitions(
    entries: readonly OptionDefinitionCacheEntry[]
  ): Promise<void> {
    const cache = this.optionDefinitionCache;
    if (cache === undefined || entries.length === 0) return;
    try {
      await cache.set(entries);
    } catch {
      // A cache is an accelerator. Discovery already holds the broker answer.
    }
  }

  private async fetchOptionChainSnapshot(
    contracts: readonly OptionContract[],
    malformedDefinitionCount: number,
    telemetry: { symbol: string; month: string; right: OptionRight },
    signal?: AbortSignal
  ): Promise<OptionChainSnapshot> {
    const fields: readonly OptionChainSnapshotField[] = [
      "bid",
      "ask",
      "mid",
      "delta",
      "volume",
      "openInterest",
      "availability",
      "timestamp",
    ];
    const missingFieldCounts = Object.fromEntries(fields.map((field) => [field, 0])) as Record<
      OptionChainSnapshotField,
      number
    >;
    const quotes = await this.fetchNullableOptionQuotes(contracts, telemetry, signal);
    for (const quote of quotes) {
      for (const field of fields) {
        if (quote[field] === null) missingFieldCounts[field] += 1;
      }
    }
    const diagnostics: OptionChainSnapshotDiagnostics = {
      qualifiedCount: contracts.length,
      returnedCount: quotes.length,
      malformedDefinitionCount,
      missingFieldCounts,
    };
    return { quotes, diagnostics };
  }

  private async fetchNullableOptionQuotes(
    contracts: readonly OptionContract[],
    telemetry?: { symbol: string; month: string; right: OptionRight | null },
    signal?: AbortSignal
  ): Promise<OptionChainSnapshotQuote[]> {
    const quotes: OptionChainSnapshotQuote[] = [];
    const batches = chunks(contracts, OPTION_MARKETDATA_BATCH_SIZE);
    const snapshotsStarted = this.requestNow();
    for (const batch of batches) {
      const params = {
        conids: batch.map((contract) => contract.conid).join(","),
        fields: OPTION_QUOTE_FIELDS,
      };
      await this.req<unknown>({ path: "iserver/marketdata/snapshot", params }, signal);
      await this.wait(2000);
      const response = await this.req<unknown>(
        { path: "iserver/marketdata/snapshot", params },
        signal
      );
      if (!Array.isArray(response)) {
        throw new Error("IBKR returned malformed option market-data snapshots");
      }
      const snapshots = response.filter(
        (snapshot): snapshot is IbkrMarketDataSnapshot & { conid: number } =>
          isUnknownRecord(snapshot) &&
          typeof snapshot["conid"] === "number" &&
          Number.isSafeInteger(snapshot["conid"]) &&
          snapshot["conid"] > 0
      );
      const byConid = new Map(snapshots.map((snapshot) => [snapshot.conid, snapshot]));
      for (const contract of batch) {
        const snapshot = byConid.get(contract.conid);
        const bid = snapshot ? (this.snapshotNumber(snapshot, "84") ?? null) : null;
        const ask = snapshot ? (this.snapshotNumber(snapshot, "86") ?? null) : null;
        const rawAvailability: unknown = snapshot?.["6509"];
        quotes.push({
          ...contract,
          bid,
          ask,
          mid: bid !== null && ask !== null ? (bid + ask) / 2 : null,
          delta: snapshot ? (this.snapshotNumber(snapshot, "7308") ?? null) : null,
          volume: snapshot ? (this.snapshotVolume(snapshot) ?? null) : null,
          openInterest: snapshot ? (this.snapshotNumber(snapshot, "7638") ?? null) : null,
          availability:
            typeof rawAvailability === "string" || typeof rawAvailability === "number"
              ? normalizeDerivativeDataAvailability(rawAvailability)
              : null,
          timestamp: snapshot ? this.snapshotTimestamp(snapshot) : null,
        });
      }
    }
    if (telemetry !== undefined) {
      this.emitOptionDiscoveryTelemetry({
        phase: "SNAPSHOTS",
        ...telemetry,
        durationMs: this.elapsedSince(snapshotsStarted),
        definitionRequestCount: 0,
        snapshotBatchCount: batches.length,
      });
    }
    return quotes;
  }

  private async fetchOptionQuotes(
    contracts: readonly OptionContract[],
    options: {
      allowIncomplete?: boolean;
      telemetry?: { symbol: string; month: string; right: OptionRight | null };
      signal?: AbortSignal;
    } = {}
  ): Promise<OptionMarketQuote[]> {
    const { allowIncomplete = false, telemetry, signal } = options;
    const result: OptionMarketQuote[] = [];
    const skipped: string[] = [];
    for (const quote of await this.fetchNullableOptionQuotes(contracts, telemetry, signal)) {
      if (quote.bid === null || quote.ask === null || quote.delta === null) {
        if (allowIncomplete) {
          skipped.push(quote.symbol);
          continue;
        }
        throw new Error(
          `IBKR returned incomplete option market data for ${quote.symbol} (bid/ask/delta required)`
        );
      }
      result.push({
        ...quote,
        bid: quote.bid,
        ask: quote.ask,
        mid: (quote.bid + quote.ask) / 2,
        delta: quote.delta,
        availability: quote.availability ?? "unavailable",
      });
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

  private historyInterval(input: PriceHistoryRequest): {
    start: number;
    end: number;
    days: number;
  } {
    if (input.days !== undefined) {
      if (!Number.isFinite(input.days) || input.days <= 0) {
        throw new Error(`History days must be positive: ${String(input.days)}`);
      }
      const days = Math.ceil(input.days);
      const endDay = this.utcDayStart(this.now());
      return { start: endDay - (days - 1) * DAY_MS, end: endDay + DAY_MS - 1, days };
    }
    if (!Number.isFinite(input.startDate) || !Number.isFinite(input.endDate)) {
      throw new Error("Price history boundaries must be finite epoch milliseconds");
    }
    if (input.endDate < input.startDate) {
      throw new Error("Price history endDate must not precede startDate");
    }
    const start = this.utcDayStart(input.startDate);
    const endDay = this.utcDayStart(input.endDate);
    return { start, end: endDay + DAY_MS - 1, days: (endDay - start) / DAY_MS + 1 };
  }

  private elapsedSince(startedAt: number): number {
    return Math.max(0, this.requestNow() - startedAt);
  }

  private emitOptionDiscoveryTelemetry(
    event: Omit<OptionDiscoveryTelemetry, "event" | OptionDiscoveryTelemetryCount> &
      Partial<Pick<OptionDiscoveryTelemetry, OptionDiscoveryTelemetryCount>>
  ): void {
    try {
      const result = this.onOptionDiscoveryTelemetry({
        event: "OPTION_DISCOVERY_PHASE",
        definitionRequestCount: 0,
        snapshotBatchCount: 0,
        listedStrikeCount: 0,
        selectedStrikeCount: 0,
        cachedDefinitionCount: 0,
        ...event,
      });
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Telemetry observers cannot change discovery or quote settlement.
    }
  }

  private async requestPriceHistory(
    contract: PriceHistoryContract,
    requestedSymbol: string,
    request: { period: string; startTime?: string }
  ): Promise<IbkrMarketDataHistoryResponse> {
    this.onPriceHistoryTelemetry({
      event: "PRICE_HISTORY_REQUEST",
      requestedSymbol,
      resolvedConid: contract.conid,
      securityType: contract.securityType,
      exchange: contract.exchange,
      period: request.period,
      barSize: "1d",
    });
    const history = await this.fetchQuoteHistory(
      contract.conid,
      request.period,
      false,
      contract.exchange,
      "1d",
      request.startTime
    );
    if (history === undefined) {
      throw new Error("IBKR price-history response was unexpectedly unavailable");
    }
    return history;
  }

  private async recoverDailyHistory(
    contract: PriceHistoryContract,
    symbol: string,
    interval: { start: number; end: number; days: number },
    initialCause: unknown
  ): Promise<PriceHistoryBar[]> {
    const observed: PriceHistoryBar[][] = [];
    let cause = initialCause;
    if (interval.days <= 365) {
      this.onRequestTelemetry({
        event: "HISTORY_PERIOD_FALLBACK",
        endpoint: "iserver/marketdata",
        attempt: 1,
        delayMs: 0,
      });
      let standardBars: PriceHistoryBar[] | undefined;
      try {
        const history = await this.requestPriceHistory(contract, symbol, {
          period: "1y",
          startTime: this.historyStartTime(interval.end),
        });
        standardBars = this.normalizeHistoryResponse(symbol, history, interval);
        this.assertHistoryCoverage(symbol, standardBars, interval);
        return standardBars;
      } catch (error) {
        if (standardBars !== undefined) observed.push(standardBars);
        if (
          !this.isChartDataUnavailable(error) &&
          !(error instanceof IbkrInsufficientHistoryError)
        ) {
          throw error;
        }
        cause = error;
      }
    }

    const windows = this.dailyHistoryWindows(symbol, interval, cause);
    const completed: { bars: PriceHistoryBar[]; start: number; end: number }[] = [];
    for (const [index, window] of windows.entries()) {
      this.onRequestTelemetry({
        event: "HISTORY_WINDOW_FALLBACK",
        endpoint: "iserver/marketdata",
        attempt: index + 1,
        delayMs: 0,
      });
      let bars: PriceHistoryBar[];
      try {
        const history = await this.requestPriceHistory(contract, symbol, {
          period: `${String(window.days)}d`,
          startTime: this.historyStartTime(window.end),
        });
        bars = this.normalizeHistoryResponse(symbol, history, window);
      } catch (error) {
        if (!this.isChartDataUnavailable(error)) throw error;
        this.throwInsufficientHistory(
          symbol,
          interval,
          [...observed, ...completed.map(({ bars }) => bars)],
          error
        );
      }
      try {
        this.assertHistoryCoverage(symbol, bars, window);
      } catch (error) {
        if (!(error instanceof IbkrInsufficientHistoryError)) throw error;
        this.throwInsufficientHistory(
          symbol,
          interval,
          [...observed, ...completed.map(({ bars: completedBars }) => completedBars), bars],
          error
        );
      }
      completed.push({ bars, start: window.start, end: window.end });
    }
    this.assertHistoryWindowContinuity(symbol, interval, completed);
    const result = this.mergeHistoryBars(
      symbol,
      completed.map(({ bars }) => bars)
    );
    this.assertHistoryCoverage(symbol, result, interval);
    return result;
  }

  private dailyHistoryWindows(
    symbol: string,
    interval: { start: number; end: number },
    cause: unknown
  ): {
    start: number;
    end: number;
    days: number;
  }[] {
    const maximumPeriodDays = 90;
    const overlapDays = 7;
    const windows: { start: number; end: number; days: number }[] = [];
    let end = interval.end;
    for (;;) {
      const endDay = this.utcDayStart(end);
      const start = Math.max(interval.start, endDay - (maximumPeriodDays - 1) * DAY_MS);
      windows.push({ start, end, days: (endDay - start) / DAY_MS + 1 });
      if (start === interval.start) return windows;
      if (windows.length >= 12) {
        throw new IbkrInsufficientHistoryError(symbol, interval.start, interval.end, null, null, {
          cause,
        });
      }
      end = start + overlapDays * DAY_MS - 1;
    }
  }

  private normalizeHistoryResponse(
    symbol: string,
    history: IbkrMarketDataHistoryResponse,
    interval: { start: number; end: number }
  ): PriceHistoryBar[] {
    const volumeFactor = history.volumeFactor ?? 1;
    if (!Number.isFinite(volumeFactor)) {
      throw new Error(`IBKR returned a non-finite history volume factor for ${symbol}`);
    }
    const bars: PriceHistoryBar[] = [];
    for (const bar of history.data ?? []) {
      if (!isFiniteHistoryBar(bar)) {
        throw new Error(`IBKR returned an incomplete or non-finite history bar for ${symbol}`);
      }
      const normalized = {
        datetime: bar.t,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v * volumeFactor,
      };
      if (!Number.isFinite(normalized.volume)) {
        throw new Error(`IBKR returned a non-finite normalized history volume for ${symbol}`);
      }
      if (bar.t < interval.start || bar.t > interval.end) continue;
      bars.push(normalized);
    }
    return this.mergeHistoryBars(symbol, [bars]);
  }

  private mergeHistoryBars(
    symbol: string,
    groups: readonly (readonly PriceHistoryBar[])[]
  ): PriceHistoryBar[] {
    const merged = new Map<number, PriceHistoryBar>();
    for (const bar of groups.flat()) {
      const existing = merged.get(bar.datetime);
      if (existing !== undefined) {
        if (
          existing.open !== bar.open ||
          existing.high !== bar.high ||
          existing.low !== bar.low ||
          existing.close !== bar.close ||
          existing.volume !== bar.volume
        ) {
          throw new Error(
            `IBKR returned conflicting history bars for ${symbol} at ${String(bar.datetime)}`
          );
        }
        continue;
      }
      merged.set(bar.datetime, bar);
    }
    return [...merged.values()].sort((left, right) => left.datetime - right.datetime);
  }

  private assertHistoryCoverage(
    symbol: string,
    bars: readonly PriceHistoryBar[],
    interval: { start: number; end: number }
  ): void {
    const availableStart = bars[0]?.datetime ?? null;
    const availableEnd = bars[bars.length - 1]?.datetime ?? null;
    const tolerance = Math.min(7 * DAY_MS, interval.end - interval.start);
    if (
      availableStart === null ||
      availableEnd === null ||
      availableStart > interval.start + tolerance ||
      availableEnd < interval.end - tolerance
    ) {
      throw new IbkrInsufficientHistoryError(
        symbol,
        interval.start,
        interval.end,
        availableStart,
        availableEnd
      );
    }
  }

  private assertHistoryWindowContinuity(
    symbol: string,
    interval: { start: number; end: number },
    windows: readonly { bars: readonly PriceHistoryBar[]; start: number; end: number }[]
  ): void {
    const chronological = [...windows].sort((left, right) => left.start - right.start);
    for (let index = 1; index < chronological.length; index += 1) {
      const older = chronological[index - 1];
      const newer = chronological[index];
      if (older === undefined || newer === undefined) continue;
      const olderEnd = older.bars[older.bars.length - 1]?.datetime;
      const newerStart = newer.bars[0]?.datetime;
      if (olderEnd === undefined || newerStart === undefined || olderEnd < newerStart) {
        this.throwInsufficientHistory(
          symbol,
          interval,
          chronological.map(({ bars }) => [...bars]),
          new Error("IBKR returned discontinuous daily history windows")
        );
      }
    }
  }

  private throwInsufficientHistory(
    symbol: string,
    interval: { start: number; end: number },
    groups: readonly (readonly PriceHistoryBar[])[],
    cause: unknown
  ): never {
    const bars = this.mergeHistoryBars(symbol, groups);
    throw new IbkrInsufficientHistoryError(
      symbol,
      interval.start,
      interval.end,
      bars[0]?.datetime ?? null,
      bars[bars.length - 1]?.datetime ?? null,
      { cause }
    );
  }

  private utcDayStart(epochMilliseconds: number): number {
    const date = new Date(epochMilliseconds);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }

  private historyStartTime(epochMilliseconds: number): string {
    const iso = new Date(epochMilliseconds).toISOString();
    return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19)}`;
  }

  private isChartDataUnavailable(error: unknown): boolean {
    const brokerDetail = error instanceof IbkrBrokerResponseError ? error.detail : undefined;
    const status = brokerDetail?.statusCode ?? this.httpStatusFromError(error);
    if (status !== 500) return false;
    const transportResponse =
      typeof error === "object" && error !== null
        ? (error as { response?: unknown }).response
        : undefined;
    const responseData =
      typeof transportResponse === "object" && transportResponse !== null
        ? (transportResponse as { data?: unknown }).data
        : undefined;
    // Normalized HTTP failures keep the raw payload under `response.body`.
    const structuredBody = error instanceof IbkrHttpError ? error.response.body : undefined;
    const body =
      typeof error === "object" && error !== null ? (error as { body?: unknown }).body : undefined;
    const payload = brokerDetail?.details ?? responseData ?? structuredBody ?? body;
    const decoded = (() => {
      if (typeof payload !== "string") return payload;
      try {
        return JSON.parse(payload) as unknown;
      } catch {
        return undefined;
      }
    })();
    if (!isUnknownRecord(decoded)) return false;
    let serialized: string;
    try {
      serialized = JSON.stringify(decoded);
    } catch {
      return false;
    }
    if (
      /auth|entitl|permission|subscription|invalid.{0,20}(?:contract|conid)|ambiguous.{0,20}contract|security definition/i.test(
        serialized
      )
    ) {
      return false;
    }
    const diagnosticValues = [decoded["error"], decoded["message"], decoded["text"]].filter(
      (value): value is string => typeof value === "string" && value.trim() !== ""
    );
    return (
      diagnosticValues.length > 0 &&
      diagnosticValues.every((value) => value.trim().toLowerCase() === "chart data unavailable")
    );
  }

  private async fetchQuoteHistory(
    conid: number,
    period = "5d",
    suppressErrors = true,
    exchange?: string,
    bar = "1d",
    startTime?: string
  ): Promise<IbkrMarketDataHistoryResponse | undefined> {
    try {
      const response = await this.historyRequest<unknown>({
        path: "iserver/marketdata/history",
        params: {
          conid: String(conid),
          ...(exchange === undefined ? {} : { exchange }),
          period,
          bar,
          outsideRth: true,
          ...(startTime === undefined ? {} : { startTime }),
        },
      });
      if (
        isUnknownRecord(response) &&
        response["error"] !== undefined &&
        response["error"] !== null
      ) {
        const detail = this.normalizeBrokerError(
          response["error"],
          response,
          "IBKR rejected the market-data history request"
        );
        throw new IbkrBrokerResponseError(detail.message, detail);
      }
      if (!isUnknownRecord(response) || !Array.isArray(response["data"])) {
        throw new Error("IBKR returned a malformed market-data history response");
      }
      return response;
    } catch (error) {
      if (!suppressErrors) throw error;
      return undefined;
    }
  }

  private normalizeTransaction(
    transaction: IbkrTransaction,
    positionsByConid: ReadonlyMap<number, IbkrPosition>
  ): BrokerTransaction {
    const conid = transaction.conid;
    const position = conid === undefined ? undefined : positionsByConid.get(conid);
    const assetType =
      position?.assetClass === undefined
        ? undefined
        : (ASSET_CLASS_LABELS[position.assetClass] ?? position.assetClass);
    const symbol = position?.contractDesc ?? (conid === undefined ? undefined : String(conid));
    const description = transaction.desc ?? symbol;
    const time = this.parseTransactionTime(transaction)?.toISOString() ?? "";
    const type = (transaction.type ?? "TRANSACTION").toUpperCase();
    const transferItem = {
      instrument: {
        ...(assetType === undefined ? {} : { assetType }),
        ...(symbol === undefined ? {} : { symbol }),
        ...(description === undefined ? {} : { description }),
      },
      ...(transaction.qty === undefined ? {} : { amount: transaction.qty }),
      ...(transaction.pr === undefined ? {} : { cost: transaction.pr }),
      transferItemType: type,
    };
    const activityId = [
      conid === undefined ? "unknown" : String(conid),
      time,
      transaction.qty === undefined ? "" : String(transaction.qty),
      transaction.amt === undefined ? "" : String(transaction.amt),
    ].join(":");

    return {
      activityId,
      time,
      type,
      status: "VALID",
      ...(transaction.acctid === undefined ? {} : { subAccount: transaction.acctid }),
      ...(description === undefined ? {} : { description }),
      netAmount: toNumber(transaction.amt),
      transferItems: [transferItem],
    };
  }

  private normalizeOrder(order: IbkrLiveOrder): BrokerOrder {
    const description =
      order.orderDescriptionWithContract ??
      order.order_description_with_contract ??
      order.orderDesc ??
      order.orderDescription ??
      order.order_description;
    const symbol =
      order.description1 ??
      order.contract_description_1 ??
      order.contractDescription1 ??
      order.symbol ??
      order.ticker;
    const quantity =
      this.firstPositiveNumber(order.total_size, order.totalSize, order.size) ??
      this.quantityFromDescription(description);
    const filledQuantity =
      this.firstNumber(order.cum_fill, order.cumFill, order.filledQuantity) ??
      this.filledQuantityFromSizeAndFills(order.size_and_fills ?? order.sizeAndFills);
    const remainingQuantity =
      order.remainingQuantity !== undefined
        ? toNumber(order.remainingQuantity)
        : quantity !== undefined && filledQuantity !== undefined
          ? Math.max(0, quantity - filledQuantity)
          : undefined;
    const status = this.normalizeOrderStatus(
      order.order_status ?? order.orderStatus ?? order.status
    );
    const price = this.firstPositiveNumber(
      order.limitPrice,
      order.price,
      order.avgPrice,
      order.average_price,
      order.averagePrice
    );
    const stopPrice = this.firstPositiveNumber(order.stopPrice);
    const orderId = order.order_id ?? order.orderId;
    const enteredTime = this.parseOrderTime(order)?.toISOString();
    const orderType = this.normalizeOrderType(order.order_type ?? order.orderType);

    return {
      ...(orderId === undefined ? {} : { orderId }),
      ...(enteredTime === undefined ? {} : { enteredTime }),
      ...(status === undefined ? {} : { status }),
      ...(orderType === undefined ? {} : { orderType }),
      ...(quantity === undefined ? {} : { quantity }),
      ...(filledQuantity === undefined ? {} : { filledQuantity }),
      ...(remainingQuantity === undefined ? {} : { remainingQuantity }),
      ...(price === undefined ? {} : { price }),
      ...(stopPrice === undefined ? {} : { stopPrice }),
      orderLegCollection: [this.normalizeOrderLeg(order, symbol)],
    };
  }

  private normalizeOrderLeg(order: IbkrLiveOrder, symbol: string | undefined): BrokerOrderLeg {
    const fallbackSymbol = symbol ?? (order.conid === undefined ? undefined : String(order.conid));
    const instruction = this.normalizeOrderSide(order.side);
    return {
      ...(instruction === undefined ? {} : { instruction }),
      instrument: { ...(fallbackSymbol === undefined ? {} : { symbol: fallbackSymbol }) },
    };
  }

  private normalizeOrderStatus(status: string | undefined): string | undefined {
    if (!status) return undefined;
    const normalized = status
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/\s+/g, "_")
      .toUpperCase();
    return normalized === "CANCELLED" ? "CANCELED" : normalized;
  }

  private normalizeOrderType(type: string | undefined): string | undefined {
    if (!type) return undefined;
    if (type === "MKT") return "MARKET";
    if (type === "LMT") return "LIMIT";
    if (type === "STP") return "STOP";
    return type.replace(/\s+/g, "_").toUpperCase();
  }

  private normalizeOrderSide(side: string | undefined): string | undefined {
    if (!side) return undefined;
    const upper = side.toUpperCase();
    if (upper === "B" || upper === "BUY") return "BUY";
    if (upper === "S" || upper === "SELL") return "SELL";
    return upper;
  }

  private ibkrStatusFilter(status: string): string {
    const normalized = status.toUpperCase();
    return IBKR_STATUS_FILTERS[normalized] ?? normalized.toLowerCase();
  }

  private orderMatchesStatus(order: BrokerOrder, requestedStatus: string | undefined): boolean {
    if (!requestedStatus) return true;
    const normalizedStatus = this.normalizeOrderStatus(requestedStatus);
    if (normalizedStatus === "WORKING") {
      return order.status !== undefined && IBKR_WORKING_STATUSES.has(order.status);
    }
    return order.status === normalizedStatus;
  }

  private orderBelongsToAccount(order: IbkrLiveOrder, accountId: string): boolean {
    const account = order.account ?? order.acct;
    return account === undefined || account === accountId;
  }

  private orderInDateRange(order: BrokerOrder, fromDate: Date, toDate: Date): boolean {
    const timeMs = this.orderTimeMs(order);
    return !Number.isFinite(timeMs) || (timeMs >= fromDate.getTime() && timeMs <= toDate.getTime());
  }

  private orderTimeMs(order: BrokerOrder): number {
    const parsed = order.enteredTime ? new Date(order.enteredTime).getTime() : Number.NaN;
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  }

  private parseOrderTime(order: IbkrLiveOrder): Date | undefined {
    if (order.lastExecutionTime_r !== undefined) {
      const parsed = new Date(order.lastExecutionTime_r);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    const value = order.order_time ?? order.orderTime ?? order.lastExecutionTime;
    if (!value) return undefined;
    const compact = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
    if (compact) {
      const [, year, month, day, hour, minute, second] = compact;
      return new Date(
        Date.UTC(
          2000 + Number(year),
          Number(month) - 1,
          Number(day),
          Number(hour),
          Number(minute),
          Number(second)
        )
      );
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  private firstNumber(...values: (string | number | undefined)[]): number | undefined {
    for (const value of values) {
      if (value === undefined) continue;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return undefined;
  }

  private firstPositiveNumber(...values: (string | number | undefined)[]): number | undefined {
    for (const value of values) {
      const numeric = this.firstNumber(value);
      if (numeric !== undefined && numeric > 0) return numeric;
    }
    return undefined;
  }

  private quantityFromDescription(description: string | undefined): number | undefined {
    const quantity = description
      ? /\b(?:Bought|Sold|Buy|Sell)\s+(?<quantity>[\d.]+)/i.exec(description)?.groups?.["quantity"]
      : undefined;
    if (!quantity) return undefined;
    const parsed = Number(quantity);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private filledQuantityFromSizeAndFills(value: string | undefined): number | undefined {
    const quantity = value ? /(?<quantity>[\d.]+)/.exec(value)?.groups?.["quantity"] : undefined;
    if (!quantity) return undefined;
    const parsed = Number(quantity);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private parseTransactionTime(transaction: IbkrTransaction): Date | undefined {
    if (transaction.rawDate && /^\d{8}$/.test(transaction.rawDate)) {
      const year = transaction.rawDate.slice(0, 4);
      const month = transaction.rawDate.slice(4, 6);
      const day = transaction.rawDate.slice(6, 8);
      return new Date(`${year}-${month}-${day}T00:00:00`);
    }
    const value = transaction.date;
    if (!value) return undefined;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    const match =
      /^(?:\w{3}) (?<month>\w{3}) (?<day>\d{1,2}) (?<time>\d{2}:\d{2}:\d{2}) (?<zone>\w{3}) (?<year>\d{4})$/.exec(
        value
      );
    if (!match?.groups) return undefined;
    const zoneOffsets: Readonly<Record<string, string>> = {
      EST: "-05:00",
      EDT: "-04:00",
      CST: "-06:00",
      CDT: "-05:00",
      MST: "-07:00",
      MDT: "-06:00",
      PST: "-08:00",
      PDT: "-07:00",
      UTC: "Z",
      GMT: "Z",
    };
    const { month, day, time, zone, year } = match.groups;
    if (!month || !day || !time || !zone || !year) return undefined;
    const normalized = `${day.padStart(2, "0")} ${month} ${year} ${time} ${zoneOffsets[zone] ?? "Z"}`;
    const fallback = new Date(normalized);
    return Number.isNaN(fallback.getTime()) ? undefined : fallback;
  }

  private transactionKey(transaction: BrokerTransaction): string {
    return [
      transaction.activityId,
      transaction.time,
      transaction.type,
      transaction.netAmount,
      transaction.transferItems?.[0]?.amount ?? "",
    ].join(":");
  }

  /** Overridable in request-level tests so snapshot warm-up does not sleep. */
  protected wait(ms: number): Promise<void> {
    return sleep(ms);
  }

  /** Overridable monotonic-enough wall clock for bounded polling tests. */
  protected now(): number {
    return Date.now();
  }

  /** Overridable entropy source for deterministic scheduler jitter tests. */
  protected random(): number {
    return Math.random();
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
    const snapshotTrade = this.snapshotTradePrice(snapshot);
    const lastPrice = snapshotTrade.last ?? latestBar?.c;
    const bidPrice = this.snapshotNumber(snapshot, "84");
    const askPrice = this.snapshotNumber(snapshot, "86");
    const closePrice = previousBar?.c ?? snapshotTrade.close;
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
      availability: normalizeDerivativeDataAvailability(snapshot["6509"]),
      timestamp: this.snapshotTimestamp(snapshot),
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
    if (!cleaned) return undefined;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /**
   * Read IBKR's `_updated` snapshot field as an ISO instant.
   *
   * `_updated` is a last-change time, not an observation time: it moves only when IBKR's record
   * for the contract changes, and a repeated request does not move it. A quiet option on a live
   * feed can hold one value for several minutes while it reports the same bid and ask, so a
   * consumer must not read the age of this value as the age of its own reading.
   */
  private snapshotTimestamp(snapshot: IbkrMarketDataSnapshot): string | null {
    const updated = this.snapshotNumber(snapshot, "_updated");
    if (updated === undefined) return null;
    const updatedMs = updated < 100_000_000_000 ? updated * 1000 : updated;
    const date = new Date(updatedMs);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  /**
   * Split IBKR snapshot field `31` into a traded last price and a previous close.
   *
   * IBKR marks the value with a `C` prefix when the contract has not traded in the current
   * session and the number is the previous close. The prefix is the only signal that separates a
   * close from a trade, so the close is reported as `close` and `last` stays undefined. A value
   * with no `C` prefix is a real last trade.
   */
  private snapshotTradePrice(snapshot: IbkrMarketDataSnapshot): {
    last: number | undefined;
    close: number | undefined;
  } {
    const value = this.snapshotNumber(snapshot, "31");
    if (value === undefined) return { last: undefined, close: undefined };
    return this.snapshotHasPrefix(snapshot, "31", "C")
      ? { last: undefined, close: value }
      : { last: value, close: undefined };
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
  protected async sendRequest<T>(input: IbkrRequestInput): Promise<T> {
    try {
      return (await this.raw.request(input)) as T;
    } catch (error) {
      throw this.normalizeHttpError(error);
    }
  }

  protected req<T>(
    input: IbkrRequestInput,
    signal?: AbortSignal,
    onTerminalFailure?: (error: unknown) => void
  ): Promise<T> {
    return this.scheduledRequest(input, "SAFE_READ", signal, onTerminalFailure);
  }

  private historyRequest<T>(input: IbkrRequestInput): Promise<T> {
    return this.scheduledRequest(input, "PRICE_HISTORY");
  }

  private singleAttemptRequest<T>(input: IbkrRequestInput): Promise<T> {
    return this.scheduledRequest(input, "SINGLE_ATTEMPT");
  }

  private scheduledRequest<T>(
    input: IbkrRequestInput,
    retryPolicy: IbkrRequestRetryPolicy,
    signal?: AbortSignal,
    onTerminalFailure?: (error: unknown) => void
  ): Promise<T> {
    if (this.closed) return Promise.reject(this.closedError());
    return this.requestScheduler.schedule(
      {
        endpoint: this.requestEndpoint(input.path),
        priority: this.requestPriority(input.path),
        secdefInfo: input.path === "iserver/secdef/info",
        retryable: retryPolicy !== "SINGLE_ATTEMPT",
        retryServerErrors: retryPolicy === "PRICE_HISTORY",
        ...(signal === undefined ? {} : { signal }),
        ...(onTerminalFailure === undefined ? {} : { onTerminalFailure }),
      },
      async () => {
        try {
          return await this.sendRequest<T>(input);
        } catch (error) {
          throw this.normalizeHttpError(error);
        }
      }
    );
  }

  private requestPriority(path: string): IbkrRequestPriority {
    if (
      path === "iserver/accounts" ||
      path === "iserver/auth/status" ||
      path.includes("/orders") ||
      path.includes("/order/status/") ||
      path === "iserver/account/trades" ||
      path.startsWith("iserver/reply/")
    ) {
      return "EXECUTION";
    }
    if (path.includes("secdef")) return "DISCOVERY";
    return "STANDARD";
  }

  private requestEndpoint(path: string): string {
    if (path.includes("secdef/")) return path.slice(path.indexOf("secdef/"));
    if (path.includes("/order/status/")) return "account/order/status";
    if (path.includes("/orders/whatif")) return "account/orders/whatif";
    if (path.endsWith("/orders")) return "account/orders";
    if (path.includes("/order/")) return "account/order";
    if (path.startsWith("iserver/reply/")) return "reply";
    if (path === "iserver/account/trades") return "account/trades";
    return path.split("/").slice(0, 2).join("/");
  }

  private classifyRequestError(error: unknown): IbkrRequestErrorClassification {
    if (
      /temporar(?:ily|y).*(?:block|ban)|(?:ip|access).*(?:temporar(?:ily|y) )?blocked/i.test(
        this.requestErrorText(error)
      )
    ) {
      return { kind: "TEMPORARILY_BLOCKED" };
    }
    const status = this.httpStatusFromError(error);
    if (status === 429) {
      const retryAfterMs = this.retryAfterFromError(error);
      return retryAfterMs === undefined
        ? { kind: "THROTTLED" }
        : { kind: "THROTTLED", retryAfterMs };
    }
    if (status !== undefined && status >= 500 && status <= 599) {
      const retryAfterMs = this.retryAfterFromError(error);
      return retryAfterMs === undefined
        ? { kind: "SERVER_ERROR" }
        : { kind: "SERVER_ERROR", retryAfterMs };
    }
    return { kind: "OTHER" };
  }

  private requestErrorText(error: unknown): string {
    if (typeof error !== "object" || error === null) return String(error);
    const message = (error as { message?: unknown }).message;
    const response = (error as { response?: unknown }).response;
    const responseData =
      typeof response === "object" && response !== null && "data" in response
        ? response.data
        : undefined;
    const body = (error as { body?: unknown }).body;
    return [message, responseData, body]
      .flatMap((value) => {
        if (typeof value === "string") return [value];
        if (value === undefined) return [];
        try {
          return [JSON.stringify(value)];
        } catch {
          return [];
        }
      })
      .join(" ");
  }

  private normalizeHttpError(error: unknown): unknown {
    if (error instanceof IbkrHttpError) return error;
    const status = this.httpStatusFromError(error);
    if (status === undefined) return error;
    const body = this.httpResponseBody(error);
    const retryAfter = this.retryAfterHeaderFromError(error) ?? null;
    const message =
      body !== ""
        ? `IBKR HTTP ${String(status)}: ${body}`
        : error instanceof Error
          ? error.message.slice(0, 4_096)
          : `IBKR HTTP ${String(status)}`;
    return new IbkrHttpError(message, status, { status, body, retryAfter }, { cause: error });
  }

  private httpResponseBody(error: unknown): string {
    if (typeof error !== "object" || error === null) return "";
    const response = (error as { response?: unknown }).response;
    const responseData =
      typeof response === "object" && response !== null
        ? ((response as { data?: unknown; body?: unknown }).data ??
          (response as { body?: unknown }).body)
        : undefined;
    const directBody = (error as { body?: unknown }).body;
    const message = (error as { message?: unknown }).message;
    const rawBody = responseData ?? directBody ?? this.bodyFromRawTransportMessage(message);
    if (typeof rawBody === "string") return rawBody.slice(0, 4_096);
    if (rawBody === undefined) return "";
    try {
      return JSON.stringify(rawBody).slice(0, 4_096);
    } catch {
      return "";
    }
  }

  private bodyFromRawTransportMessage(message: unknown): string | undefined {
    if (typeof message !== "string") return undefined;
    return /^Response status \d{3}: ([\s\S]*)$/.exec(message)?.[1];
  }

  private httpStatusFromError(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const response = (error as { response?: unknown }).response;
    const directStatus = this.numberFromUnknown((error as { status?: unknown }).status);
    if (directStatus !== undefined) return directStatus;
    const directStatusCode = this.numberFromUnknown((error as { statusCode?: unknown }).statusCode);
    if (directStatusCode !== undefined) return directStatusCode;
    if (typeof response === "object" && response !== null) {
      const responseStatus = this.numberFromUnknown(
        (response as { status?: unknown }).status ??
          (response as { statusCode?: unknown }).statusCode
      );
      if (responseStatus !== undefined) return responseStatus;
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message !== "string") return undefined;
    const rawStatus = /^Response status (\d{3}):/.exec(message)?.[1];
    return rawStatus === undefined ? undefined : this.numberFromUnknown(rawStatus);
  }

  private retryAfterFromError(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const structuredRetryAfter =
      error instanceof IbkrHttpError ? (error.response.retryAfter ?? undefined) : undefined;
    return parseRetryAfter(
      structuredRetryAfter ?? this.retryAfterHeaderFromError(error),
      this.requestNow()
    );
  }

  private retryAfterHeaderFromError(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const response = (error as { response?: unknown }).response;
    const responseHeaders =
      response && typeof response === "object" && "headers" in response
        ? response.headers
        : undefined;
    const directHeaders = (error as { headers?: unknown }).headers;
    return (
      this.headerValue(responseHeaders, "Retry-After") ??
      this.headerValue(directHeaders, "Retry-After")
    );
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
