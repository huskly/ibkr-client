/**
 * Raw IBKR Client Portal Web API response shapes (only the fields we read).
 * The `ibkr-client` `request()` method returns `any`; these types let us cast
 * once at the boundary and stay typed everywhere else.
 *
 * See: https://www.interactivebrokers.com/campus/ibkr-api-page/webapi-ref/
 */

export interface IbkrAuthStatus {
  authenticated?: boolean;
  competing?: boolean;
  connected?: boolean;
}

export interface IbkrPortfolioAccount {
  accountId: string;
  type?: string;
  currency?: string;
}

/** A single field in the `portfolio/{accountId}/summary` response. */
export interface IbkrSummaryField {
  amount?: number;
  currency?: string;
}

export type IbkrPortfolioSummary = Record<string, IbkrSummaryField | undefined>;

/** A row from `portfolio/{accountId}/positions/{page}`. */
export interface IbkrPosition {
  conid?: number;
  contractDesc?: string;
  assetClass?: string;
  position?: number;
  avgPrice?: number;
  mktPrice?: number;
  mktValue?: number;
  multiplier?: number;
  unrealizedPnl?: number;
}

/** A row from `iserver/marketdata/snapshot`. Fields are numbered strings. */
export type IbkrMarketDataSnapshot = Record<string, string | number | undefined> & {
  conid?: number;
};

/** A contract under a listing in the `trsrv/stocks` response. */
export interface IbkrStockContract {
  conid?: number;
  exchange?: string;
  isUS?: boolean;
}

/** A listing (one per company) in the `trsrv/stocks` response. */
export interface IbkrStockListing {
  name?: string;
  assetClass?: string;
  contracts?: IbkrStockContract[];
}

/** `trsrv/stocks` response: keyed by the requested symbol. */
export type IbkrStocksResponse = Record<string, IbkrStockListing[] | undefined>;

/** One OHLCV bar from `iserver/marketdata/history`. */
export interface IbkrMarketDataHistoryBar {
  o?: number;
  c?: number;
  h?: number;
  l?: number;
  v?: number;
  t?: number;
}

/** `iserver/marketdata/history` response. */
export interface IbkrMarketDataHistoryResponse {
  symbol?: string;
  text?: string;
  volumeFactor?: number;
  data?: IbkrMarketDataHistoryBar[];
}

/** A security-definition search result. Calling this endpoint primes strikes for the session. */
export interface IbkrSecdefSearchResult {
  conid?: number;
  symbol?: string;
  sections?: { secType?: string; months?: string; exchange?: string }[];
}

export interface IbkrSecdefStrikesResponse {
  call?: number[];
  put?: number[];
}

export interface IbkrSecdefInfo {
  conid?: number;
  symbol?: string;
  maturityDate?: string;
  right?: string;
  strike?: number;
}

/** `trsrv/secdef` response keyed by conid. */
export type IbkrSecdefByConidResponse = Record<
  string,
  | {
      conid?: number;
      symbol?: string;
      expiry?: string;
      putOrCall?: string;
      strike?: string | number;
    }
  | undefined
>;
