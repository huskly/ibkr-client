/**
 * Broker-neutral domain types shared across the CLI.
 *
 * Command handlers render these normalized shapes and never touch raw broker
 * JSON. Both the IBKR client (here) and Schwab (when this is merged into
 * huskly-cli) implement {@link BrokerClient}, so a single set of handlers can
 * serve either broker. The field names mirror huskly-cli's `getAccountBalances`
 * / `SchwabPosition` shapes to keep that future merge mechanical.
 */

export type BrokerName = "ibkr" | "schwab";

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
 * The contract every broker client satisfies. Kept intentionally small (account,
 * positions, quotes); extend as commands are added.
 */
export interface BrokerClient {
  getAuthStatus(): Promise<AuthStatus>;
  getAccountId(): Promise<string>;
  getAccountBalances(): Promise<AccountBalances>;
  getPositions(symbol?: string): Promise<BrokerPosition[]>;
  getQuotes(symbols: string[]): Promise<Record<string, BrokerQuote>>;
}
