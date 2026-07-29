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
