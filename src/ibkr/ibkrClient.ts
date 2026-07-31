import { createRequire } from "node:module";
import type { IbkrClient as RawIbkrClient } from "ibkr-client";
import type { IbkrOauth1Config } from "./oauthConfig.js";
import type {
  AccountBalances,
  AuthStatus,
  BrokerAccountOrders,
  BrokerClient,
  BrokerInstrument,
  BrokerInstrumentSearchProjection,
  BrokerOrder,
  BrokerOrderLeg,
  BrokerOrdersOptions,
  BrokerPosition,
  BrokerQuote,
  BrokerTransaction,
  BrokerTransactionHistory,
  BrokerErrorDetail,
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
  DerivativeOrderCancellationResult,
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
  OptionContract,
  OptionMarketQuote,
  OptionQuoteRequest,
  OptionRight,
  OrderWarning,
  PriceHistoryBar,
  PriceHistoryRequest,
  TradingDiagnostics,
} from "../types.js";
import { ASSET_CLASS_LABELS, toNumber } from "../helpers.js";
import type {
  IbkrAuthStatus,
  IbkrBrokerageAccountsResponse,
  IbkrLiveOrder,
  IbkrLiveOrdersResponse,
  IbkrOrderSubmissionResponse,
  IbkrOrderCancellationResponse,
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

/** Live market-data snapshot field 78 = position's P&L for the current day. */
const DAY_PNL_FIELD = "78";
const OPTION_QUOTE_FIELDS = [
  "84", // Bid
  "86", // Ask
  "87", // Formatted volume
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
const OPTION_DISCOVERY_MONTH_CONCURRENCY = 1;
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
const KNOWN_ORDER_WARNING_IDS = new Set(["o163"]);

interface DecodedOrderSubmission {
  orders: DerivativeSubmittedOrder[];
  warnings: OrderWarning[];
  errors: BrokerErrorDetail[];
  unrecognizedResponses: Readonly<Record<string, unknown>>[];
}

/** Extract the canonical OSI symbol embedded in an IBKR option description. */
function extractOsiPositionSymbol(contractDescription: string): string | undefined {
  return /\[([A-Z]+\s*\d{6}[CP]\d{8})\s+\d+\]\s*$/.exec(contractDescription)?.[1];
}

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

interface IbkrRequestInput {
  path: string;
  method?: string;
  params?: Record<string, string | number | boolean | null | undefined>;
  data?: object;
}

export interface IbkrClientOptions {
  requestScheduler?: Omit<
    IbkrRequestSchedulerOptions,
    "now" | "sleep" | "random" | "classifyError" | "onTelemetry"
  >;
  onRequestTelemetry?: (event: IbkrRequestTelemetry) => void;
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
    DerivativeDiscoveryClient,
    DerivativePreviewClient,
    DerivativeExecutionClient
{
  private readonly raw: RawIbkrClient;
  private initPromise?: Promise<void>;
  private accountIdPromise?: Promise<string>;
  private readonly optionDiscovery = new Map<string, Promise<OptionContract[]>>();
  private readonly derivativeDiscovery = new Map<string, Promise<DerivativeContract[]>>();
  private readonly requestScheduler: IbkrRequestScheduler;

  constructor(config: IbkrOauth1Config, options: IbkrClientOptions = {}) {
    this.raw = new RawIbkrClientCtor(config);
    this.requestScheduler = new IbkrRequestScheduler({
      ...options.requestScheduler,
      now: () => this.now(),
      sleep: (ms) => this.wait(ms),
      random: () => this.random(),
      classifyError: (error) => this.classifyRequestError(error),
      ...(options.onRequestTelemetry === undefined
        ? {}
        : { onTelemetry: options.onRequestTelemetry }),
    });
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

  async getTradingDiagnostics(accountId: string): Promise<TradingDiagnostics> {
    if (!accountId.trim()) throw new Error("An explicit IBKR account ID is required");
    const [status, accounts] = await Promise.all([
      this.getAuthStatus(),
      this.req<IbkrBrokerageAccountsResponse>({ path: "iserver/accounts" }),
    ]);
    if (!accounts.accounts?.includes(accountId)) {
      throw new Error(`IBKR account ${accountId} is not available to this session`);
    }
    return {
      accountId,
      selectedAccountId: accounts.selectedAccount ?? null,
      environment: accounts.isPaper === true ? "paper" : "live",
      authenticated: status.authenticated,
      competingSession: status.competing,
      marketDataAvailable: accounts.allowFeatures?.showGFIS ?? null,
      advisoryAssetPermissions:
        accounts.allowFeatures?.allowedAssetTypes
          ?.split(",")
          .map((value) => value.trim())
          .filter(Boolean) ?? [],
    };
  }

  async previewDerivativeCombo(
    request: DerivativeComboPreviewRequest
  ): Promise<DerivativeComboPreviewResult> {
    this.validateComboPreview(request);
    const diagnostics = await this.getTradingDiagnostics(request.accountId);
    if (!diagnostics.authenticated || diagnostics.competingSession) {
      throw new Error("IBKR brokerage session is not safely authenticated for What-If");
    }
    await this.prepareBrokerageAccount(request.accountId);
    const conids = request.legs.map(({ contract }) => contract.conid).join(",");
    await this.req<unknown>({
      path: "iserver/marketdata/snapshot",
      params: { conids, fields: "6509" },
    });
    const response = await this.req<IbkrWhatIfResponse>({
      path: `iserver/account/${request.accountId}/orders/whatif`,
      method: "POST",
      data: {
        orders: [this.comboOrderTicket(request)],
      },
    });
    return this.normalizeComboPreview(request.accountId, diagnostics, response);
  }

  async submitDerivativeCombo(
    request: DerivativeComboExecutionRequest
  ): Promise<DerivativeOrderSubmissionResult> {
    this.validateComboPreview(request);
    if (!request.clientOrderId.trim() || request.clientOrderId.length > 64) {
      throw new Error("Client order ID must contain 1 to 64 characters");
    }
    const cmeOperatorMetadata = this.cmeOperatorMetadata(
      request.legs[0].contract.assetClass,
      request
    );
    const diagnostics = await this.getTradingDiagnostics(request.accountId);
    if (!diagnostics.authenticated || diagnostics.competingSession) {
      throw new Error("IBKR brokerage session is not safely authenticated for submission");
    }
    await this.prepareBrokerageAccount(request.accountId);
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

  async submitDerivativeSingleOrder(
    request: DerivativeSingleOrderRequest
  ): Promise<DerivativeOrderSubmissionResult> {
    this.validateSingleOrder(request);
    const cmeOperatorMetadata = this.cmeOperatorMetadata(request.contract.assetClass, request);
    const diagnostics = await this.getTradingDiagnostics(request.accountId);
    if (!diagnostics.authenticated || diagnostics.competingSession) {
      throw new Error("IBKR brokerage session is not safely authenticated for submission");
    }
    await this.prepareBrokerageAccount(request.accountId);
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

  async submitDerivativeContingentOrders(request: {
    accountId: string;
    parent: DerivativeContingentParentOrderRequest;
    child: DerivativeContingentChildOrderRequest;
  }): Promise<DerivativeMultiOrderResult> {
    const { accountId, parent, child } = request;
    if (!accountId.trim()) throw new Error("An explicit IBKR account ID is required");
    if (parent.accountId !== accountId || child.accountId !== accountId) {
      throw new Error("Contingent parent and child orders must target the exact same account");
    }
    this.validateSingleOrderFields(parent);
    this.validateSingleOrderFields(child);
    if (!parent.clientOrderId.trim() || parent.clientOrderId.length > 64) {
      throw new Error("Parent client order ID must contain 1 to 64 characters");
    }
    if ("clientOrderId" in child || "parentId" in child) {
      throw new Error("Contingent child identity is derived from the parent order");
    }
    const parentMetadata = this.cmeOperatorMetadata(parent.contract.assetClass, parent);
    const childMetadata = this.cmeOperatorMetadata(child.contract.assetClass, child);
    const diagnostics = await this.getTradingDiagnostics(accountId);
    if (!diagnostics.authenticated || diagnostics.competingSession) {
      throw new Error("IBKR brokerage session is not safely authenticated for submission");
    }
    await this.prepareBrokerageAccount(accountId);
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
    return this.normalizeMultiOrderSubmission(response, parent.clientOrderId);
  }

  async acknowledgeOrderWarning(input: {
    replyId: string;
    confirmed: true;
  }): Promise<DerivativeOrderSubmissionResult> {
    if (!input.replyId.trim()) throw new Error("An exact warning reply ID is required");
    const response = await this.singleAttemptRequest<
      IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[]
    >({
      path: `iserver/reply/${encodeURIComponent(input.replyId)}`,
      method: "POST",
      data: { confirmed: true },
    });
    return this.normalizeOrderSubmission(response, null);
  }

  async acknowledgeContingentOrderWarning(input: {
    continuation: { replyId: string; parentClientOrderId: string };
    confirmed: true;
  }): Promise<DerivativeMultiOrderResult> {
    if (!input.continuation.replyId.trim()) {
      throw new Error("An exact warning reply ID is required");
    }
    if (!input.continuation.parentClientOrderId.trim()) {
      throw new Error("An exact parent client order ID is required");
    }
    const response = await this.singleAttemptRequest<
      IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[]
    >({
      path: `iserver/reply/${encodeURIComponent(input.continuation.replyId)}`,
      method: "POST",
      data: { confirmed: true },
    });
    return this.normalizeMultiOrderSubmission(response, input.continuation.parentClientOrderId);
  }

  async getDerivativeOrderStatus(
    accountId: string,
    orderId: string
  ): Promise<DerivativeOrderLifecycle> {
    if (!accountId.trim() || !orderId.trim()) {
      throw new Error("Exact account and order IDs are required");
    }
    await this.prepareBrokerageAccount(accountId);
    const order = await this.req<IbkrLiveOrder>({
      path: `iserver/account/order/status/${encodeURIComponent(orderId)}`,
    });
    if (String(order.order_id ?? order.orderId ?? "") !== orderId) {
      throw new Error(`IBKR response does not match the requested order ${orderId}`);
    }
    if ((order.account ?? order.acct) !== accountId) {
      throw new Error(`IBKR order ${orderId} does not belong to the requested account`);
    }
    const lifecycle = this.normalizeDerivativeOrderLifecycle(accountId, orderId, order);
    if (lifecycle.status === "UNKNOWN") {
      throw new Error(`IBKR order ${orderId} returned an unrecognized status`);
    }
    return lifecycle;
  }

  async findDerivativeOrder(input: DerivativeOrderLookup): Promise<DerivativeOrderLifecycle> {
    if (!input.accountId.trim()) throw new Error("An exact account ID is required");
    const identity = input.orderId ?? input.clientOrderId;
    if (!identity.trim()) throw new Error("An exact broker or client order ID is required");
    if (input.orderId !== undefined) {
      return this.getDerivativeOrderStatus(input.accountId, input.orderId);
    }
    await this.prepareBrokerageAccount(input.accountId);
    const response = await this.req<IbkrLiveOrdersResponse>({
      path: "iserver/account/orders",
      params: { force: true, accountId: input.accountId },
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
    return this.getDerivativeOrderStatus(input.accountId, String(orderId));
  }

  async getDerivativeExecutions(input: DerivativeExecutionQuery): Promise<DerivativeExecution[]> {
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
  }

  async reconcileDerivativeComboExecution(
    request: DerivativeComboReconciliationRequest
  ): Promise<DerivativeComboReconciliation> {
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
    if (!input.accountId.trim() || !input.orderId.trim()) {
      throw new Error("Exact account and order IDs are required");
    }
    const cmeOperatorMetadata = this.cmeOperatorMetadata(input.assetClass, input);
    await this.prepareBrokerageAccount(input.accountId);
    const response = await this.singleAttemptRequest<IbkrOrderCancellationResponse>({
      path: `iserver/account/${input.accountId}/order/${encodeURIComponent(input.orderId)}`,
      method: "DELETE",
      ...(Object.keys(cmeOperatorMetadata).length > 0 ? { params: cmeOperatorMetadata } : {}),
    });
    return {
      state: "requested",
      accountId: input.accountId,
      orderId: input.orderId,
      message: this.trimmedString(response.msg),
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
    const contractDescription = p.contractDesc ?? String(p.conid ?? "-");
    const symbol =
      assetClass === "OPT"
        ? (extractOsiPositionSymbol(contractDescription) ?? contractDescription)
        : contractDescription;
    return {
      symbol,
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
  async searchInstruments(
    symbol: string,
    projection: BrokerInstrumentSearchProjection = "symbol-search"
  ): Promise<BrokerInstrument[]> {
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
    const accountId = await this.getAccountId();
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
  }

  private validateComboPreview(request: DerivativeComboPreviewRequest): void {
    if (!request.accountId.trim()) throw new Error("An explicit IBKR account ID is required");
    if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0) {
      throw new Error("Combo quantity must be a positive integer");
    }
    if (!Number.isFinite(request.limit) || request.limit <= 0) {
      throw new Error("Combo limit must be a positive number");
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

  private validateSingleOrder(request: DerivativeSingleOrderRequest): void {
    this.validateSingleOrderFields(request);
    const identityFields = request as unknown as {
      clientOrderId?: unknown;
      parentId?: unknown;
    };
    const clientOrderId =
      typeof identityFields.clientOrderId === "string" ? identityFields.clientOrderId : undefined;
    const parentId =
      typeof identityFields.parentId === "string" ? identityFields.parentId : undefined;
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
    orderType: "LMT";
    price: number;
    side: "BUY";
    tif: "DAY" | "GTC";
    quantity: number;
    outsideRTH: boolean;
  } {
    const exchange = request.legs[0].contract.exchange;
    const spreadConid = exchange === "SMART" ? "28812380" : `28812380@${exchange}`;
    return {
      acctId: request.accountId,
      conidex: `${spreadConid};;;${request.legs
        .map(({ contract, ratio }) => `${String(contract.conid)}/${String(ratio)}`)
        .join(",")}`,
      orderType: "LMT",
      price: request.priceEffect === "CREDIT" ? -request.limit : request.limit,
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
    const orders = decoded.orders.map((order) => ({ ...order, clientOrderId }));
    const hasWarnings = decoded.warnings.length > 0;
    const hasErrors = decoded.errors.length > 0;
    const hasUnknown = decoded.unrecognizedResponses.length > 0;

    if (hasWarnings && !hasErrors && orders.length === 0 && !hasUnknown) {
      return { state: "warning", warnings: decoded.warnings };
    }
    if (hasErrors && !hasWarnings && orders.length === 0 && !hasUnknown) {
      return {
        state: "rejected",
        reasons: decoded.errors.map(({ message }) => message),
        errors: decoded.errors,
      };
    }
    if (!hasWarnings && !hasErrors && !hasUnknown && orders.length === 1) {
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

  private normalizeMultiOrderSubmission(
    response: IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[],
    parentClientOrderId: string
  ): DerivativeMultiOrderResult {
    const decoded = this.decodeOrderSubmission(response);
    const rolesArePositionallyComplete =
      decoded.orders.length === 2 &&
      decoded.warnings.length === 0 &&
      decoded.errors.length === 0 &&
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
        continuation: { replyId: warning.replyId, parentClientOrderId },
      };
    }
    if (hasErrors && !hasWarnings && orders.length === 0 && !hasUnknown) {
      return {
        state: "rejected",
        parentClientOrderId,
        reasons: decoded.errors.map(({ message }) => message),
        errors: decoded.errors,
      };
    }
    if (!hasWarnings && !hasErrors && !hasUnknown && orders.length === 2) {
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

  private decodeOrderSubmission(
    response: IbkrOrderSubmissionResponse | IbkrOrderSubmissionResponse[]
  ): DecodedOrderSubmission {
    const items = Array.isArray(response) ? response : [response];
    const decoded: DecodedOrderSubmission = {
      orders: [],
      warnings: [],
      errors: [],
      unrecognizedResponses: [],
    };
    for (const item of items) {
      let recognized = false;
      if ("id" in item && typeof item.id === "string") {
        const messageIds = Array.isArray(item.messageIds)
          ? item.messageIds.filter((value): value is string => typeof value === "string")
          : [];
        decoded.warnings.push({
          replyId: item.id,
          messages: Array.isArray(item.message)
            ? item.message.filter((value): value is string => typeof value === "string")
            : [],
          messageIds,
          known: messageIds.length > 0 && messageIds.every((id) => KNOWN_ORDER_WARNING_IDS.has(id)),
        });
        recognized = true;
      }
      if ("error" in item && item.error !== undefined && item.error !== null) {
        decoded.errors.push(this.normalizeBrokerError(item.error, item));
        recognized = true;
      }
      const orderId =
        ("order_id" in item ? item.order_id : undefined) ??
        ("orderId" in item ? item.orderId : undefined);
      if (typeof orderId === "string" || typeof orderId === "number") {
        const orderStatus =
          ("order_status" in item ? item.order_status : undefined) ??
          ("orderStatus" in item ? item.orderStatus : undefined);
        decoded.orders.push({
          orderId: String(orderId),
          status: this.normalizeDerivativeOrderStatus(
            typeof orderStatus === "string" ? orderStatus : undefined,
            0,
            0
          ),
          clientOrderId: null,
        });
        recognized = true;
      }
      if (!recognized) decoded.unrecognizedResponses.push({ ...item });
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
    const terminal = decoded.orders.find(
      ({ status }) => status === "REJECTED" || status === "CANCELED"
    );
    if (terminal !== undefined) {
      return `Order ${terminal.orderId} returned terminal status ${terminal.status}`;
    }
    if (decoded.orders.some(({ status }) => status === "UNKNOWN")) {
      return "IBKR returned an order ID with an unknown status";
    }
    if (decoded.errors.length > 0 && decoded.warnings.length > 0) {
      return "IBKR returned both warnings and rejections for one submission";
    }
    if (orderCount !== expectedOrderCount) {
      return `IBKR returned ${String(orderCount)} of ${String(expectedOrderCount)} expected order acknowledgements`;
    }
    if (decoded.unrecognizedResponses.length > 0) {
      return "IBKR returned one or more unrecognized order responses";
    }
    if (decoded.warnings.length > 1) {
      return "IBKR returned multiple warning continuations for one submission";
    }
    return "IBKR returned mixed or incomplete order evidence";
  }

  private normalizeBrokerError(
    error: unknown,
    response: Readonly<Record<string, unknown>>
  ): BrokerErrorDetail {
    const nested = typeof error === "object" && error !== null ? error : undefined;
    const nestedMessage = nested ? (nested as { message?: unknown }).message : undefined;
    const responseMessage = response["message"];
    const message =
      (typeof nestedMessage === "string" && nestedMessage.trim()) ||
      (typeof error === "string" && error.trim()) ||
      (typeof responseMessage === "string" && responseMessage.trim()) ||
      "IBKR rejected the order";
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
    const remainingQuantity = this.firstNumber(
      order.remainingQuantity,
      order.remaining_size,
      order.remaining
    );
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
      limitPrice: this.firstNumber(order.limitPrice, order.limit_price, order.price) ?? null,
      commissionAndFees:
        typeof order.commissionAndFees === "number"
          ? order.commissionAndFees
          : this.whatIfNumber(order.commissionAndFees),
      legs: this.parseComboLegs(order.conidex),
      updatedAt: this.parseOrderTime(order)?.toISOString() ?? null,
    };
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

  private trimmedString(value: string | undefined): string | null {
    if (value === undefined) return null;
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
    value: string | undefined,
    filledQuantity: number,
    remainingQuantity: number
  ): DerivativeOrderStatus {
    const status = value
      ?.replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/\s+/g, "_")
      .toUpperCase();
    if (filledQuantity > 0 && remainingQuantity > 0) return "PARTIALLY_FILLED";
    if (status === "FILLED") return "FILLED";
    if (status === "CANCELLED" || status === "CANCELED") return "CANCELED";
    if (status === "INACTIVE" || status === "REJECTED") return "REJECTED";
    if (status === "API_PENDING" || status === "PENDING_SUBMIT") return "PENDING";
    if (status !== undefined && IBKR_WORKING_STATUSES.has(status)) return "WORKING";
    return "UNKNOWN";
  }

  private normalizeComboPreview(
    accountId: string,
    diagnostics: TradingDiagnostics,
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

  private async prepareBrokerageAccount(accountId: string): Promise<void> {
    const brokerageAccounts = await this.req<IbkrBrokerageAccountsResponse>({
      path: "iserver/accounts",
    });
    if (brokerageAccounts.selectedAccount === accountId) return;
    if (brokerageAccounts.accounts && !brokerageAccounts.accounts.includes(accountId)) {
      throw new Error(`IBKR account ${accountId} is not available for trading/order queries.`);
    }
    await this.req<IbkrSwitchAccountResponse>({
      path: "iserver/account",
      method: "POST",
      data: { acctId: accountId },
    });
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

  /** Discover listed derivative series over an inclusive calendar range. */
  async getDerivativeExpiries(query: DerivativeExpiryQuery): Promise<DerivativeExpiry[]> {
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
    return {
      conid: referenceConid,
      symbol: String(snapshot?.["55"] ?? detail?.undSym ?? contract.underlying),
      availability: normalizeDerivativeDataAvailability(snapshot?.["6509"]),
      timestamp: snapshot ? this.snapshotTimestamp(snapshot) : null,
      bid,
      ask,
      last: snapshot ? (this.snapshotNumber(snapshot, "31") ?? null) : null,
      mark: suppliedMark ?? (bid !== null && ask !== null ? (bid + ask) / 2 : null),
    };
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

  private async loadDerivativeContracts(
    underlying: string,
    assetClass: DerivativeAssetClass,
    month: string,
    requestedExchange?: string,
    requestedRight?: OptionRight,
    requestedStrike?: number
  ): Promise<DerivativeContract[]> {
    // IBKR keeps this priming state in the authenticated session. Strikes may be
    // empty when search has not run first, even with otherwise identical params.
    const search = await this.req<IbkrSecdefSearchResult[]>({
      path: "iserver/secdef/search",
      params: { symbol: underlying, ...(assetClass === "FOP" ? { secType: "FUT" } : {}) },
    });
    const candidates = search.filter(
      (candidate) =>
        candidate.conid !== undefined &&
        candidate.symbol?.trim().toUpperCase() === underlying &&
        candidate.sections?.some((section) => section.secType?.toUpperCase() === assetClass)
    );
    if (candidates.length !== 1) {
      throw new Error(
        `IBKR ${assetClass} underlying identity is ${candidates.length ? "ambiguous" : "missing"} for ${underlying}`
      );
    }
    const candidate = candidates[0];
    if (!candidate) throw new Error(`IBKR lost the selected underlying for ${underlying}`);
    const conid = Number(candidate.conid);
    if (!Number.isSafeInteger(conid) || conid <= 0) {
      throw new Error(`IBKR returned an invalid underlying contract id for ${underlying}`);
    }
    const section = candidate.sections?.find((item) => item.secType?.toUpperCase() === assetClass);
    const exchanges = (section?.exchange ?? "")
      .split(";")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
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
        result.push({
          contract,
          availability: normalizeDerivativeDataAvailability(snapshot?.["6509"]),
          timestamp: snapshot ? this.snapshotTimestamp(snapshot) : null,
          bid: snapshot ? (this.snapshotNumber(snapshot, "84") ?? null) : null,
          ask: snapshot ? (this.snapshotNumber(snapshot, "86") ?? null) : null,
          last: snapshot ? (this.snapshotNumber(snapshot, "31") ?? null) : null,
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
        const volume = snapshot ? (this.snapshotVolume(snapshot) ?? null) : null;
        const openInterest = snapshot ? (this.snapshotNumber(snapshot, "7638") ?? null) : null;
        result.push({
          ...contract,
          bid,
          ask,
          mid: (bid + ask) / 2,
          delta,
          volume,
          openInterest,
        });
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
    if (!cleaned) return undefined;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private snapshotTimestamp(snapshot: IbkrMarketDataSnapshot): string | null {
    const updated = this.snapshotNumber(snapshot, "_updated");
    if (updated === undefined) return null;
    const updatedMs = updated < 100_000_000_000 ? updated * 1000 : updated;
    const date = new Date(updatedMs);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
    return (await this.raw.request(input)) as T;
  }

  protected req<T>(input: IbkrRequestInput): Promise<T> {
    return this.scheduledRequest(input, true);
  }

  private singleAttemptRequest<T>(input: IbkrRequestInput): Promise<T> {
    return this.scheduledRequest(input, false);
  }

  private scheduledRequest<T>(input: IbkrRequestInput, retryable: boolean): Promise<T> {
    return this.requestScheduler.schedule(
      {
        endpoint: this.requestEndpoint(input.path),
        priority: this.requestPriority(input.path),
        retryable,
      },
      () => this.sendRequest<T>(input)
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
    if (this.httpStatusFromError(error) === 429) {
      const retryAfterMs = this.retryAfterFromError(error);
      return retryAfterMs === undefined
        ? { kind: "THROTTLED" }
        : { kind: "THROTTLED", retryAfterMs };
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
