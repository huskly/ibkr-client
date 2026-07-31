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

export interface AccountBalances {
  netLiquidation: number;
  availableFunds: number;
  buyingPower: number;
  cashBalance: number;
}

export interface BrokerPosition {
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
export interface BrokerQuote {
  symbol: string;
  reference: BrokerQuoteReference;
  quote: BrokerQuoteData;
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
export type DerivativeDataAvailability =
  "live" | "delayed" | "frozen" | "frozen-delayed" | "unavailable";

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

export interface DerivativeComboPreviewRequest {
  accountId: string;
  legs: [DerivativeComboLeg, DerivativeComboLeg];
  quantity: number;
  priceEffect: "CREDIT" | "DEBIT";
  limit: number;
  tif: "DAY" | "GTC";
  session: "REGULAR" | "OVERNIGHT";
}

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
  /** Parent nodes must precede children; graphs are deliberately bounded to eight members. */
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
  | { accountId: string; orderId: string; rootClientOrderId?: never };

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
  limitPrice: number | null;
  commissionAndFees: number | null;
  legs: DerivativeOrderLegStatus[];
  updatedAt: string | null;
}

/** Why an active order cannot be treated as complete, unambiguous risk evidence. */
export type ActiveDerivativeOrderUncertainty =
  | "UNKNOWN_STATUS"
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
  underlying: string;
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
}

export interface PriceHistoryRequest {
  symbol: string;
  days?: number;
  startDate?: number;
  endDate?: number;
}

export interface OptionQuoteRequest {
  symbol: string;
  expiry: string;
  strike: number;
  right: OptionRight;
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
  getQuotes(symbols: string[]): Promise<Record<string, BrokerQuote>>;
  searchInstruments(
    symbol: string,
    projection?: BrokerInstrumentSearchProjection
  ): Promise<BrokerInstrument[]>;
  fetchTransactionHistory(startDate: Date, endDate: Date): Promise<BrokerTransactionHistory[]>;
  fetchOrders(options: BrokerOrdersOptions): Promise<BrokerAccountOrders[]>;
}
