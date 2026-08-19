/**
 * Broker-neutral domain types exposed by the IBKR client.
 *
 * The client normalizes raw IBKR JSON into these shapes so consumers do not
 * depend on provider-specific response payloads. The field names align with
 * the broker-neutral interfaces consumed by huskly-cli.
 */

export type BrokerInstrumentSearchProjection =
  "symbol-search" | "symbol-regex" | "desc-search" | "desc-regex" | "search" | "fundamental";

export interface AuthStatus {
  authenticated: boolean;
  competing: boolean;
}

export interface AccountMarginSnapshot {
  equityWithLoanValue: number | null;
  regTEquity: number | null;
  regTMargin: number | null;
  initialMarginRequirement: number | null;
  maintenanceMarginRequirement: number | null;
  availableFunds: number | null;
  excessLiquidity: number | null;
  cushion: number | null;
  sma: number | null;
  buyingPower: number | null;
  fullInitialMarginRequirement: number | null;
  fullMaintenanceMarginRequirement: number | null;
  fullAvailableFunds: number | null;
  fullExcessLiquidity: number | null;
  lookAheadInitialMarginRequirement: number | null;
  lookAheadMaintenanceMarginRequirement: number | null;
  lookAheadAvailableFunds: number | null;
  lookAheadExcessLiquidity: number | null;
  lookAheadNextChange: number | null;
  leverage: number | null;
}

export interface AccountMargin {
  total: AccountMarginSnapshot;
  securities: AccountMarginSnapshot;
  commodities: AccountMarginSnapshot;
}

export interface AccountBalances {
  netLiquidation: number;
  availableFunds: number;
  buyingPower: number;
  cashBalance: number;
  margin: AccountMargin;
}

export interface BrokerPosition {
  /** Broker-native contract id for exact reads in the current broker session. */
  brokerId: string;
  /** Human-readable contract symbol/description. */
  symbol: string;
  /** Normalized asset type, e.g. EQUITY, OPTION, FUTURE. */
  assetType: string;
  longQuantity: number;
  shortQuantity: number;
  averagePrice: number;
  /** Contract multiplier when IBKR supplies one (normally 100 for US equity options). */
  multiplier?: number;
  marketPrice: number;
  marketValue: number;
  /** P/L for the current trading day. */
  currentDayProfitLoss: number;
  /** Unrealized open P/L. */
  openProfitLoss: number;
}

export interface BrokerInstrument {
  /** Broker-native contract id (IBKR conid), as a string. */
  brokerId?: string;
  symbol?: string;
  description?: string;
  exchange?: string;
  assetType?: string;
}

export interface BrokerTransferItem {
  instrument?: {
    assetType?: string;
    symbol?: string;
    description?: string;
  };
  amount?: number;
  cost?: number;
  transferItemType?: string;
  feeType?: string;
}

export interface BrokerTransaction {
  activityId: string | number;
  time: string;
  type: string;
  status: string;
  subAccount?: string;
  description?: string;
  netAmount: number;
  transferItems?: BrokerTransferItem[];
}

export interface BrokerTransactionHistory {
  accountNumber: string;
  transactions: BrokerTransaction[];
}

export interface BrokerOrderLeg {
  instrument?: { symbol?: string };
  instruction?: string;
}

export interface BrokerOrder {
  orderId?: string | number;
  enteredTime?: string;
  status?: string;
  orderType?: string;
  complexOrderStrategyType?: string;
  quantity?: number;
  filledQuantity?: number;
  remainingQuantity?: number;
  price?: number;
  stopPrice?: number;
  orderLegCollection?: BrokerOrderLeg[];
}

export interface BrokerOrdersOptions {
  fromEnteredTime: Date;
  toEnteredTime: Date;
  status?: string;
  maxResults?: number;
}

export interface BrokerAccountOrders {
  accountNumber: string;
  orders: BrokerOrder[];
}

export interface BrokerQuoteReference {
  description?: string;
  exchange?: string;
  exchangeName?: string;
}

export interface BrokerQuoteData {
  lastPrice?: number;
  bidPrice?: number;
  askPrice?: number;
  closePrice?: number;
  highPrice?: number;
  lowPrice?: number;
  openPrice?: number;
  netChange?: number;
  netPercentChange?: number;
  totalVolume?: number;
}

/**
 * Broker-neutral quote, mirroring huskly-cli's (Schwab-shaped) `BrokerQuote` so
 * consumers normalize IBKR and Schwab quotes through one code path.
 */
export interface BrokerQuoteRequest {
  /** Stable caller-facing key used in the returned quote record. */
  symbol: string;
  /** Broker-native contract id from the current broker session, when already known. */
  brokerId?: string;
}

/** Controls the provider data that {@link BrokerClient.getQuotes} requests. */
export interface BrokerQuoteOptions {
  /** Add daily price history to the market-data snapshot. Defaults to true. */
  includeHistory?: boolean;
}

export interface BrokerQuote {
  symbol: string;
  reference: BrokerQuoteReference;
  quote: BrokerQuoteData;
  /** Whether this snapshot is live, delayed, frozen, or absent (IBKR field 6509). */
  availability: MarketDataAvailability;
  /** ISO 8601 instant the snapshot was last updated; null when IBKR reports no update time. */
  timestamp: string | null;
}

/** One normalized daily/intraday market-data history bar. */
export interface PriceHistoryBar {
  datetime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type OptionRight = "C" | "P";

/** Derivative security types supported by IBKR security-definition discovery. */
export type DerivativeAssetClass = "OPT" | "FOP";

/** Normalized market-data timeline reported by IBKR snapshot field 6509. */
export type MarketDataAvailability =
  "live" | "delayed" | "frozen" | "frozen-delayed" | "unavailable";

/** Derivative-specific spelling of {@link MarketDataAvailability}; the values are identical. */
export type DerivativeDataAvailability = MarketDataAvailability;

/** Query one exact expiration while retaining trading-class and venue identity. */
export interface DerivativeContractQuery {
  assetClass: DerivativeAssetClass;
  underlying: string;
  expiration: string;
  exchange?: string;
  tradingClass?: string;
  right?: OptionRight;
  strike?: number;
}

/** Query derivative expirations over an inclusive calendar range. */
export interface DerivativeExpiryQuery {
  assetClass: DerivativeAssetClass;
  underlying: string;
  from: string;
  to: string;
  exchange?: string;
  tradingClass?: string;
  right?: OptionRight;
}

/** A listed derivative series. No broker-local contract id is part of this identity. */
export interface DerivativeExpiry {
  assetClass: DerivativeAssetClass;
  underlying: string;
  expiration: string;
  tradingClass: string;
  exchange: string;
  multiplier: number;
}

/**
 * An exact IBKR derivative contract. All fields except {@link conid} form semantic
 * identity; conid is broker-local and must not be persisted as durable identity.
 */
export interface DerivativeContract extends DerivativeExpiry {
  conid: number;
  strike: number;
  right: OptionRight;
  settlement?: string;
  exerciseStyle?: string;
}

/** A derivative quote whose nullable fields preserve missing provider data honestly. */
export interface DerivativeQuote {
  contract: DerivativeContract;
  availability: DerivativeDataAvailability;
  timestamp: string | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  mark: number | null;
  delta: number | null;
  impliedVolatility: number | null;
  volume: number | null;
  openInterest: number | null;
}

/** Broker-linked market reference for a derivative's true underlying contract. */
export interface DerivativeReferenceQuote {
  conid: number;
  symbol: string;
  availability: DerivativeDataAvailability;
  timestamp: string | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  mark: number | null;
}

/** Capability-specific read-only derivative discovery boundary. */
export interface DerivativeDiscoveryClient {
  getDerivativeExpiries(query: DerivativeExpiryQuery): Promise<DerivativeExpiry[]>;
  getDerivativeContracts(query: DerivativeContractQuery): Promise<DerivativeContract[]>;
  resolveDerivativeContract(
    query: DerivativeContractQuery & { right: OptionRight; strike: number }
  ): Promise<DerivativeContract>;
  getDerivativeChain(query: DerivativeContractQuery): Promise<DerivativeQuote[]>;
  getDerivativeReferenceQuote(contract: DerivativeContract): Promise<DerivativeReferenceQuote>;
}

export type BrokerEnvironment = "live" | "paper";

export interface TradingDiagnostics {
  accountId: string;
  selectedAccountId: string | null;
  environment: BrokerEnvironment;
  authenticated: boolean;
  competingSession: boolean;
  marketDataAvailable: boolean | null;
  advisoryAssetPermissions: string[];
}

export interface DerivativeComboLeg {
  contract: DerivativeContract;
  ratio: 1 | -1;
}

interface DerivativeComboOrderFields {
  accountId: string;
  legs: [DerivativeComboLeg, DerivativeComboLeg];
  quantity: number;
  priceEffect: "CREDIT" | "DEBIT";
  tif: "DAY" | "GTC";
  session: "REGULAR" | "OVERNIGHT";
}

/**
 * A combo (BAG) order's net price, signed by `priceEffect` exactly like a single-leg order's
 * `limit`/`stopPrice`: negative for CREDIT, positive for DEBIT. STP exists so a combo can carry
 * its own protective stop - a BAG parent can only take a BAG child at IBKR, so a vertical's
 * protection must itself be a combo order, not a single-leg STOP (huskly/strategy-terminal#527).
 */
export type DerivativeComboPreviewRequest = DerivativeComboOrderFields &
  (
    | { orderType: "LMT"; limit: number; stopPrice?: never }
    | { orderType: "STP"; stopPrice: number; limit?: never }
  );

export interface MarginImpact {
  current: number;
  change: number;
  after: number;
}

export interface DerivativeComboPreviewResult {
  accountId: string;
  environment: BrokerEnvironment;
  accepted: boolean;
  submitted: false;
  commission: number | null;
  initialMargin: MarginImpact | null;
  maintenanceMargin: MarginImpact | null;
  warnings: string[];
  rejectionReasons: string[];
  advisoryAssetPermissions: string[];
}

/** Explicit What-If capability. It contains no live placement operation. */
export interface DerivativePreviewClient {
  getTradingDiagnostics(accountId: string): Promise<TradingDiagnostics>;
  previewDerivativeCombo(
    request: DerivativeComboPreviewRequest
  ): Promise<DerivativeComboPreviewResult>;
}

/** CME Rule 536-B metadata. Both fields must be supplied together when required. */
export type CmeOperatorMetadata =
  | { extOperator: string; manualIndicator: boolean }
  | { extOperator?: never; manualIndicator?: never };

export type DerivativeComboExecutionRequest = DerivativeComboPreviewRequest & {
  clientOrderId: string;
} & CmeOperatorMetadata;

export type DerivativeOrderSide = "BUY" | "SELL";

export type DerivativeSingleOrderType = "LMT" | "STP";

/** Order kinds accepted in a derivative graph. MARKET is intentionally graph-only. */
export type DerivativeOrderGraphOrderType = DerivativeSingleOrderType | "MKT";

type DerivativeSingleOrderFields = {
  accountId: string;
  contract: DerivativeContract;
  side: DerivativeOrderSide;
  quantity: number;
  tif: "DAY" | "GTC";
  session: "REGULAR" | "OVERNIGHT";
} & (
  | { orderType: "LMT"; limit: number; stopPrice?: never }
  | { orderType: "STP"; stopPrice: number; limit?: never }
) &
  CmeOperatorMetadata;

export type DerivativeSingleOrderRequest = DerivativeSingleOrderFields &
  ({ clientOrderId: string; parentId?: never } | { clientOrderId?: never; parentId: string });

export type DerivativeContingentParentOrderRequest = DerivativeSingleOrderFields & {
  clientOrderId: string;
  parentId?: never;
};

/** IBKR bracket children use parentId and must not send their own cOID. */
export type DerivativeContingentChildOrderRequest = DerivativeSingleOrderFields & {
  clientOrderId?: never;
  parentId?: never;
};

export interface DerivativeSubmittedOrder {
  orderId: string;
  status: DerivativeOrderStatus;
  clientOrderId: string | null;
}

export interface DerivativeContingentOrderEvidence extends DerivativeSubmittedOrder {
  role: "parent" | "child" | "unknown";
}

export interface DerivativeContingentWarningContinuation {
  replyId: string;
  parentClientOrderId: string;
}

/** Caller-stable identity and complete placement evidence for one graph member. */
export type DerivativeOrderGraphNode =
  | ({
      memberId: string;
      parentMemberId?: string;
    } & DerivativeComboPreviewRequest &
      CmeOperatorMetadata)
  | ({
      memberId: string;
      parentMemberId?: string;
      accountId: string;
      contract: DerivativeContract;
      side: DerivativeOrderSide;
      quantity: number;
      tif: "DAY" | "GTC";
      session: "REGULAR" | "OVERNIGHT";
    } & (
      | { orderType: "LMT"; limit: number; stopPrice?: never }
      | { orderType: "STP"; stopPrice: number; limit?: never }
      | { orderType: "MKT"; limit?: never; stopPrice?: never }
    ) &
      CmeOperatorMetadata);

export interface DerivativeOrderGraphRequest {
  accountId: string;
  /** Durable caller correlation for the root and the complete graph. */
  rootClientOrderId: string;
  /** Each non-root node can name any earlier member; graphs are bounded to eight members. */
  nodes: readonly DerivativeOrderGraphNode[];
}

export interface DerivativeOrderGraphMemberEvidence {
  memberId: string;
  role: "root" | "child" | "grandchild" | "descendant" | "unknown";
  parentMemberId: string | null;
  parentOrderId: string | null;
  orderId: string | null;
  status: DerivativeOrderStatus;
  clientOrderId: string;
  request: DerivativeOrderGraphNode;
}

/** JSON-safe evidence required to resume the exact broker reply after restart. */
export interface DerivativeOrderGraphWarningContinuation {
  replyId: string;
  request: DerivativeOrderGraphRequest;
  members: DerivativeOrderGraphMemberEvidence[];
}

export type DerivativeOrderGraphResult =
  | {
      state: "accepted";
      rootClientOrderId: string;
      members: DerivativeOrderGraphMemberEvidence[];
      warnings: OrderWarning[];
    }
  | {
      state: "warning";
      rootClientOrderId: string;
      members: DerivativeOrderGraphMemberEvidence[];
      warnings: OrderWarning[];
      continuation: DerivativeOrderGraphWarningContinuation;
    }
  | {
      state: "rejected";
      rootClientOrderId: string;
      members: DerivativeOrderGraphMemberEvidence[];
      reasons: string[];
      errors: BrokerErrorDetail[];
    }
  | {
      state: "recovery_required";
      rootClientOrderId: string;
      members: DerivativeOrderGraphMemberEvidence[];
      reasons: string[];
      warnings: OrderWarning[];
      errors: BrokerErrorDetail[];
      unrecognizedResponses: unknown[];
    };

export type DerivativeOrderGraphLookup =
  | { accountId: string; rootClientOrderId: string; orderId?: never }
  | {
      accountId: string;
      /** An exact broker order ID from the caller's durable checkpoint. */
      orderId: string;
      rootClientOrderId?: never;
    };

export type DerivativeMultiOrderResult =
  | {
      state: "accepted";
      orders: [DerivativeContingentOrderEvidence, DerivativeContingentOrderEvidence];
      warnings: OrderWarning[];
    }
  | {
      state: "warning";
      warnings: OrderWarning[];
      continuation: DerivativeContingentWarningContinuation;
    }
  | {
      state: "rejected";
      parentClientOrderId: string;
      reasons: string[];
      errors: BrokerErrorDetail[];
      orders?: DerivativeContingentOrderEvidence[];
    }
  | {
      state: "recovery_required";
      parentClientOrderId: string;
      reasons: string[];
      orders: DerivativeContingentOrderEvidence[];
      warnings: OrderWarning[];
      errors: BrokerErrorDetail[];
      unrecognizedResponses: unknown[];
    };

export type DerivativeOrderCancelRequest = {
  accountId: string;
  orderId: string;
  assetClass: DerivativeAssetClass;
} & CmeOperatorMetadata;

export interface OrderWarning {
  replyId: string;
  messages: string[];
  messageIds: string[];
  known: boolean;
}

/** A normalized broker rejection with the complete provider response retained for diagnostics. */
export interface BrokerErrorDetail {
  message: string;
  code: string | null;
  statusCode: number | null;
  details: Readonly<Record<string, unknown>>;
}

export type DerivativeOrderSubmissionResult =
  | {
      state: "accepted";
      orderId: string;
      status: DerivativeOrderStatus;
      clientOrderId: string | null;
      warnings: OrderWarning[];
    }
  | { state: "warning"; warnings: OrderWarning[] }
  | {
      state: "rejected";
      reasons: string[];
      errors: BrokerErrorDetail[];
      orders?: DerivativeSubmittedOrder[];
    }
  | {
      state: "recovery_required";
      reasons: string[];
      orders: DerivativeSubmittedOrder[];
      warnings: OrderWarning[];
      errors: BrokerErrorDetail[];
      unrecognizedResponses: unknown[];
    };

export type DerivativeOrderStatus =
  | "WARNING_PENDING"
  | "PENDING"
  | "WORKING"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "UNKNOWN";

export interface DerivativeOrderLegStatus {
  conid: number;
  ratio: number;
}

export interface DerivativeOrderLifecycle {
  accountId: string;
  orderId: string;
  clientOrderId: string | null;
  status: DerivativeOrderStatus;
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  averagePrice: number | null;
  /**
   * The normalized IBKR order type, for example `LIMIT` or `STOP`, or `null` when the broker
   * stated none. This is the same normalization the active-order snapshot applies.
   */
  orderType: string | null;
  limitPrice: number | null;
  /** The stop trigger price, or `null` when the broker stated none. */
  stopPrice: number | null;
  commissionAndFees: number | null;
  legs: DerivativeOrderLegStatus[];
  updatedAt: string | null;
}

/** Why an active order cannot be treated as complete, unambiguous risk evidence. */
export type ActiveDerivativeOrderUncertainty =
  | "UNKNOWN_STATUS"
  | "UNKNOWN_SIDE"
  | "MISSING_BROKER_ORDER_ID"
  | "MISSING_LEG_IDENTITY"
  | "MALFORMED_CONIDEX"
  | "AGGREGATE_ONLY"
  | "MISSING_PARENT"
  | "AMBIGUOUS_PARENT"
  | "DUPLICATE_MEMBER"
  | "INCOMPLETE_QUANTITIES"
  | "PARTIAL_GRAPH";

export interface ActiveDerivativeOptionIdentity {
  symbol: string;
  /**
   * The OSI root read from the order description, which names the listing class rather than the
   * underlying. `SPXW` is the root of an SPX weekly. The description carries no underlying, so
   * none is reported rather than guessed.
   */
  root: string;
  expiry: string;
  strike: number;
  right: OptionRight;
}

export interface ActiveDerivativeOrderLeg {
  conid: number | null;
  /** Signed combo ratio: positive buys and negative sells. */
  ratio: number | null;
  side: DerivativeOrderSide | "UNKNOWN";
  quantity: number | null;
  option: ActiveDerivativeOptionIdentity | null;
  uncertainty: ActiveDerivativeOrderUncertainty[];
}

/** One member of the active order graph returned by Client Portal. */
export interface ActiveDerivativeOrder {
  accountId: string;
  orderId: string | null;
  clientOrderId: string | null;
  parentOrderId: string | null;
  parentClientOrderId: string | null;
  graphRole: "ROOT" | "CHILD" | "UNKNOWN";
  status: DerivativeOrderStatus;
  totalQuantity: number | null;
  filledQuantity: number | null;
  remainingQuantity: number | null;
  tif: string | null;
  session: "REGULAR" | "OVERNIGHT" | "UNKNOWN";
  orderType: string | null;
  limitPrice: number | null;
  stopPrice: number | null;
  enteredAt: string | null;
  updatedAt: string | null;
  legs: ActiveDerivativeOrderLeg[];
  uncertainty: ActiveDerivativeOrderUncertainty[];
}

export type DerivativeOrderLookup =
  | { accountId: string; orderId: string; clientOrderId?: never }
  | { accountId: string; orderId?: never; clientOrderId: string };

export interface DerivativeExecutionQuery {
  accountId: string;
  /** IBKR supports the current day through the previous six days. */
  days?: number;
  orderId?: string;
  clientOrderId?: string;
}

/** One broker execution/fill. Combo orders produce one or more records per leg. */
export interface DerivativeExecution {
  accountId: string;
  executionId: string;
  orderId: string | null;
  clientOrderId: string | null;
  conid: number;
  symbol: string | null;
  side: "BUY" | "SELL" | "UNKNOWN";
  quantity: number;
  price: number | null;
  commission: number | null;
  commissionCurrency: string | null;
  netAmount: number | null;
  exchange: string | null;
  executedAt: string | null;
}

export interface DerivativeOrderCancellationResult {
  state: "requested";
  accountId: string;
  orderId: string;
  message: string | null;
}

export type DerivativeExecutionSide = "BUY" | "SELL";

export interface DerivativeComboReconciliationRequest {
  accountId: string;
  orderId: string;
  clientOrderId: string;
  legs: [{ conid: number; ratio: number }, { conid: number; ratio: number }];
  quantity: number;
  multiplier: number;
  timeoutMs?: number;
  pollMs?: number;
}

export interface DerivativeLegExecutionSummary {
  conid: number;
  side: DerivativeExecutionSide;
  quantity: number;
  averagePrice: number;
  commission: number;
  executionCount: number;
}

/** Sanitized aggregate output; raw execution and account identifiers are intentionally omitted. */
export interface DerivativeComboReconciliation {
  state: "PENDING" | "VERIFIED" | "RECOVERY_REQUIRED";
  reason: string | null;
  aggregateStatus: DerivativeOrderStatus;
  filledQuantity: number;
  remainingQuantity: number;
  legs: DerivativeLegExecutionSummary[];
  grossPoints: number | null;
  multiplier: number;
  grossAmount: number | null;
  commission: number | null;
  netAmount: number | null;
}

export interface DerivativeExecutionClient {
  submitDerivativeOrderGraph(
    request: DerivativeOrderGraphRequest
  ): Promise<DerivativeOrderGraphResult>;
  acknowledgeDerivativeOrderGraphWarning(input: {
    continuation: DerivativeOrderGraphWarningContinuation;
    confirmed: true;
  }): Promise<DerivativeOrderGraphResult>;
  recoverDerivativeOrderGraph(
    input: DerivativeOrderGraphLookup,
    request: DerivativeOrderGraphRequest
  ): Promise<DerivativeOrderGraphResult>;
  listActiveDerivativeOrders(accountId: string): Promise<ActiveDerivativeOrder[]>;
  submitDerivativeCombo(
    request: DerivativeComboExecutionRequest
  ): Promise<DerivativeOrderSubmissionResult>;
  submitDerivativeSingleOrder(
    request: DerivativeSingleOrderRequest
  ): Promise<DerivativeOrderSubmissionResult>;
  submitDerivativeContingentOrders(request: {
    accountId: string;
    parent: DerivativeContingentParentOrderRequest;
    child: DerivativeContingentChildOrderRequest;
  }): Promise<DerivativeMultiOrderResult>;
  acknowledgeOrderWarning(input: {
    replyId: string;
    confirmed: true;
  }): Promise<DerivativeOrderSubmissionResult>;
  acknowledgeContingentOrderWarning(input: {
    continuation: DerivativeContingentWarningContinuation;
    confirmed: true;
  }): Promise<DerivativeMultiOrderResult>;
  getDerivativeOrderStatus(accountId: string, orderId: string): Promise<DerivativeOrderLifecycle>;
  findDerivativeOrder(input: DerivativeOrderLookup): Promise<DerivativeOrderLifecycle>;
  getDerivativeExecutions(input: DerivativeExecutionQuery): Promise<DerivativeExecution[]>;
  reconcileDerivativeComboExecution(
    request: DerivativeComboReconciliationRequest
  ): Promise<DerivativeComboReconciliation>;
  cancelDerivativeOrder(
    input: DerivativeOrderCancelRequest
  ): Promise<DerivativeOrderCancellationResult>;
}

/**
 * An IBKR option contract with durable OSI identity. The conid is intentionally retained
 * only at this broker boundary; consumers should persist {@link symbol}, not {@link conid}.
 */
export interface OptionContract {
  conid: number;
  symbol: string;
  underlying: string;
  /**
   * The IBKR listing class of this contract, for example `SPX` or `SPXW`, or `null` when IBKR
   * stated none.
   *
   * Two classes of one underlying list the same expiry, strike, and right as different products
   * with different settlement, so the class is part of contract identity and is the root of
   * {@link symbol}.
   *
   * `null` means the broker did not report a class, not that the contract has none. The root of
   * {@link symbol} then falls back to {@link underlying}, and discovery refuses a month in which
   * two conids reach one symbol, so an unstated class cannot hide a collision.
   */
  tradingClass: string | null;
  expiry: string;
  strike: number;
  right: OptionRight;
}

/** A fully priced option contract suitable for delta-based strategy selection. */
export interface OptionMarketQuote extends OptionContract {
  bid: number;
  ask: number;
  mid: number;
  delta: number;
  volume: number | null;
  openInterest: number | null;
  /** Whether this snapshot is live, delayed, frozen, or absent (IBKR field 6509). */
  availability: MarketDataAvailability;
  /** ISO 8601 instant the snapshot was last updated; null when IBKR reports no update time. */
  timestamp: string | null;
}

/** Market-data fields that can be absent from a complete listed option-chain snapshot. */
export type OptionChainSnapshotField =
  "bid" | "ask" | "mid" | "delta" | "volume" | "openInterest" | "availability" | "timestamp";

/** A listed option contract that preserves unavailable broker market data as null. */
export interface OptionChainSnapshotQuote extends OptionContract {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  delta: number | null;
  volume: number | null;
  openInterest: number | null;
  availability: MarketDataAvailability | null;
  timestamp: string | null;
}

/** Safe counts that explain the completeness of an option-chain snapshot. */
export interface OptionChainSnapshotDiagnostics {
  qualifiedCount: number;
  returnedCount: number;
  malformedDefinitionCount: number;
  missingFieldCounts: Record<OptionChainSnapshotField, number>;
}

/** Every qualified contract for one exact expiry and option side, with completeness diagnostics. */
export interface OptionChainSnapshot {
  quotes: OptionChainSnapshotQuote[];
  diagnostics: OptionChainSnapshotDiagnostics;
}

/** IBKR security types that a price-history contract can report. */
export type PriceHistorySecurityType =
  "STK" | "IND" | "OPT" | "FUT" | "FOP" | "CASH" | "CFD" | "WAR" | "FUND" | "BOND" | "CMDTY";

/** An explicit IBKR contract selector for a price-history request. */
export interface PriceHistoryContractSelector {
  conid: number;
  /** Optional IBKR security type, such as `STK` or `IND`. */
  assetClass?: PriceHistorySecurityType;
  /** Optional exact exchange, such as `NASDAQ` or `CBOE`. */
  exchange?: string;
}

/** Validated IBKR contract metadata used for a price-history request. */
export interface PriceHistoryContract {
  conid: number;
  symbol: string;
  securityType: PriceHistorySecurityType;
  exchange: string;
}

/** Safe contract evidence returned with an ambiguous resolution error. */
export interface PriceHistoryContractCandidate {
  conid: number;
  symbol: string;
  securityType: PriceHistorySecurityType;
  exchange: string | null;
}

export type PriceHistoryRequest = {
  symbol: string;
  /** Use an explicit conid when a symbol has more than one contract. */
  contract?: PriceHistoryContractSelector;
} & (
  | { days: number; startDate?: never; endDate?: never }
  | { days?: never; startDate: number; endDate: number }
);

/** Safe metadata emitted immediately before an IBKR price-history request. */
export interface PriceHistoryTelemetry {
  event: "PRICE_HISTORY_REQUEST";
  requestedSymbol: string;
  resolvedConid: number;
  securityType: string;
  exchange: string;
  period: string;
  barSize: string;
}

/** Price-history bars together with the exact broker request context. */
export interface PriceHistoryResult {
  bars: PriceHistoryBar[];
  contract: PriceHistoryContract;
  request: {
    requestedSymbol: string;
    period: string;
    barSize: string;
  };
}

export interface OptionQuoteRequest {
  symbol: string;
  expiry: string;
  strike: number;
  right: OptionRight;
  /**
   * The IBKR listing class to resolve, for example `SPXW`.
   *
   * Required only where one underlying lists the same expiry, strike, and right in more than one
   * class. Omitted, the request accepts any class and refuses when more than one answers, because
   * two classes are two products with different settlement.
   */
  tradingClass?: string;
}

/** Safe phase timing for option discovery. It never contains account or credential data. */
export interface OptionDiscoveryTelemetry {
  event: "OPTION_DISCOVERY_PHASE";
  phase: "SEARCH" | "STRIKES" | "DEFINITIONS" | "SNAPSHOTS";
  symbol: string;
  month: string;
  right: OptionRight | null;
  durationMs: number;
  definitionRequestCount: number;
  snapshotBatchCount: number;
  /** Strikes the month lists, before {@link OptionStrikeRange} removes any. */
  listedStrikeCount: number;
  /** Strikes kept after {@link OptionStrikeRange}. Equal to the listed count when no range applies. */
  selectedStrikeCount: number;
  /** Definitions an {@link OptionDefinitionCache} supplied, so no request was made for them. */
  cachedDefinitionCount: number;
}

/**
 * An inclusive strike band for one discovery operation. A caller that knows which strikes it can
 * use supplies this band, because a security definition costs one paced `secdef/info` request for
 * each strike, and a broad-index month lists thousands of strikes.
 *
 * A bound that is not a finite number is refused. An empty object selects every listed strike.
 */
export interface OptionStrikeRange {
  /** Lowest strike to resolve, inclusive. */
  min?: number;
  /** Highest strike to resolve, inclusive. */
  max?: number;
}

/** The identity of one security definition. It holds no price and no greek. */
export interface OptionDefinitionCacheKey {
  underlyingConid: number;
  /** IBKR month token, for example `AUG26`. */
  month: string;
  right: OptionRight;
  strike: number;
}

/** One cache record: the contracts IBKR returned for one {@link OptionDefinitionCacheKey}. */
export interface OptionDefinitionCacheEntry {
  key: OptionDefinitionCacheKey;
  contracts: readonly OptionContract[];
}

/**
 * A store for resolved option security definitions.
 *
 * A definition is identity only: conid, symbol, underlying, expiry, strike, and right. It holds no
 * price, no greek, and no availability, so a cached record can never reach a pricing decision.
 *
 * The cache is an accelerator, never an authority. The client treats a rejected promise, a
 * malformed record, and a length mismatch the same as a miss, and it then asks the broker.
 */
export interface OptionDefinitionCache {
  /**
   * Read the cached contracts for each key. The result is aligned to `keys` by index. `null` at one
   * index is a miss; an empty array is a hit that records a strike IBKR does not list.
   */
  get(
    keys: readonly OptionDefinitionCacheKey[]
  ): Promise<readonly (readonly OptionContract[] | null)[]>;
  /** Store the contracts the broker resolved. A rejected promise is logged by the caller, not fatal. */
  set(entries: readonly OptionDefinitionCacheEntry[]): Promise<void>;
}

/**
 * The broker-neutral contract implemented by {@link IbkrClient}. Kept
 * intentionally small around account, position, quote, transaction, and order
 * data needed by consumers.
 */
export interface BrokerClient {
  getAuthStatus(): Promise<AuthStatus>;
  getAccountId(): Promise<string>;
  getAccountBalances(): Promise<AccountBalances>;
  getPositions(symbol?: string): Promise<BrokerPosition[]>;
  getQuotes(
    requests: readonly BrokerQuoteRequest[],
    options?: BrokerQuoteOptions
  ): Promise<Record<string, BrokerQuote>>;
  searchInstruments(
    symbol: string,
    projection?: BrokerInstrumentSearchProjection
  ): Promise<BrokerInstrument[]>;
  fetchTransactionHistory(startDate: Date, endDate: Date): Promise<BrokerTransactionHistory[]>;
  fetchOrders(options: BrokerOrdersOptions): Promise<BrokerAccountOrders[]>;
}
