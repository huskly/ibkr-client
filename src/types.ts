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
  marketPrice: number;
  marketValue: number;
  /** P/L for the current trading day. */
  currentDayProfitLoss: number;
  /** Unrealized open P/L. */
  openProfitLoss: number;
}

/**
 * The contract every broker client satisfies. Kept intentionally small for the
 * initial foundation (account + positions); extend as commands are added.
 */
export interface BrokerClient {
  getAuthStatus(): Promise<AuthStatus>;
  getAccountId(): Promise<string>;
  getAccountBalances(): Promise<AccountBalances>;
  getPositions(symbol?: string): Promise<BrokerPosition[]>;
}
