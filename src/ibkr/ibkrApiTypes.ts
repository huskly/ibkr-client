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

export interface IbkrTransactionsResponse {
  currency?: string;
  from?: number;
  to?: number;
  includesRealTime?: boolean;
  transactions?: IbkrTransaction[];
}

export interface IbkrTransaction {
  date?: string;
  rawDate?: string;
  cur?: string;
  fxRate?: number;
  pr?: number;
  qty?: number;
  acctid?: string;
  amt?: number;
  conid?: number;
  type?: string;
  desc?: string;
}

export interface IbkrLiveOrdersResponse {
  orders?: IbkrLiveOrder[];
  snapshot?: boolean;
}

export interface IbkrBrokerageAccountsResponse {
  accounts?: string[];
  selectedAccount?: string;
  isPaper?: boolean;
  allowFeatures?: {
    showGFIS?: boolean;
    allowedAssetTypes?: string;
  };
}

export interface IbkrWhatIfValues {
  current?: string;
  change?: string;
  after?: string;
}

export interface IbkrWhatIfResponse {
  amount?: { amount?: string; commission?: string; total?: string };
  initial?: IbkrWhatIfValues;
  maintenance?: IbkrWhatIfValues;
  warn?: string | null;
  error?: string | null;
}

export interface IbkrSwitchAccountResponse {
  set?: boolean;
  acctId?: string;
}

export interface IbkrLiveOrder {
  account?: string;
  acct?: string;
  orderId?: number | string;
  order_id?: number | string;
  conid?: number;
  ticker?: string;
  symbol?: string;
  description1?: string;
  contractDescription1?: string;
  contract_description_1?: string;
  side?: string;
  orderType?: string;
  order_type?: string;
  orderStatus?: string;
  order_status?: string;
  status?: string;
  totalSize?: string | number;
  total_size?: string | number;
  size?: string | number;
  cumFill?: string | number;
  cum_fill?: string | number;
  filled?: string | number;
  filledQuantity?: string | number;
  remaining?: string | number;
  remaining_size?: string | number;
  remainingQuantity?: string | number;
  sizeAndFills?: string;
  size_and_fills?: string;
  avgPrice?: string | number;
  avg_price?: string | number;
  averagePrice?: string | number;
  average_price?: string | number;
  price?: string | number;
  limit_price?: string | number;
  limitPrice?: string | number;
  stopPrice?: string | number;
  orderDescription?: string;
  order_description?: string;
  orderDesc?: string;
  orderDescriptionWithContract?: string;
  order_description_with_contract?: string;
  lastExecutionTime?: string;
  lastExecutionTime_r?: number;
  orderTime?: string;
  order_time?: string;
  conidex?: string;
  cOID?: string;
  parentId?: string | number;
  order_ref?: string;
  commissionAndFees?: string | number;
}

export interface IbkrOrderAcceptedResponse {
  order_id?: string | number;
  orderId?: string | number;
  order_status?: string;
  orderStatus?: string;
}

export interface IbkrOrderWarningResponse {
  id?: string;
  message?: string[];
  messageIds?: string[];
}

export interface IbkrOrderRejectedResponse {
  error?: unknown;
  statusCode?: number;
  code?: string | number;
  message?: string;
  [key: string]: unknown;
}

export type IbkrOrderSubmissionResponse =
  IbkrOrderAcceptedResponse | IbkrOrderWarningResponse | IbkrOrderRejectedResponse;

export interface IbkrOrderCancellationResponse {
  msg?: string;
  order_id?: string | number;
  conid?: number;
  account?: string;
}

export interface IbkrTrade {
  execution_id?: string;
  order_id?: string | number;
  order_ref?: string;
  account?: string;
  accountCode?: string;
  conid?: number;
  symbol?: string;
  contract_description_1?: string;
  side?: string;
  size?: string | number;
  price?: string | number;
  commission?: string | number;
  net_amount?: string | number;
  exchange?: string;
  trade_time?: string;
  trade_time_r?: number;
}

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
  conid?: number | string;
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
  secType?: string;
  exchange?: string;
  listingExchange?: string | null;
  maturityDate?: string;
  right?: string;
  strike?: number;
  multiplier?: string | number;
  tradingClass?: string;
  validExchanges?: string;
  settlement?: string;
  exerciseStyle?: string;
}

/** `trsrv/secdef` response used to locate a derivative's broker-linked underlying. */
export interface IbkrSecdefContract {
  conid?: number;
  ticker?: string;
  undConid?: number;
  undSym?: string;
}

export interface IbkrSecdefResponse {
  secdef?: IbkrSecdefContract[];
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
