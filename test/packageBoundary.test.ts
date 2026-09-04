import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  IbkrHttpError,
  IbkrInsufficientHistoryError,
  IbkrPriceHistoryContractError,
  type AccountBalances,
  type AccountSettledCashByDate,
  type AccountSettlementEvidence,
  type AccountSettlementFigure,
  type BrokerClient,
  type BrokerEnvironment,
  type DerivativeComboPreviewResult,
  type DerivativeExecutionClient,
  type DerivativeOrderCancellationEvidence,
  type DerivativeOrderCancellationResult,
  type DerivativeContingentWarningContinuation,
  type BrokerQuoteOptions,
  type BrokerQuoteRequest,
  type ContractTransactionEvidence,
  type ContractTransactionRecord,
  type IbkrClient,
  type IbkrClientOptions,
  type IbkrContractReferenceEvidence,
  type IbkrHttpErrorResponse,
  type IbkrJsonEvidence,
  type IbkrSessionEvidence,
  type IbkrSessionLifecycleClient,
  type IbkrRequestSchedulerOptions,
  type IbkrRequestTelemetry,
  type OptionChainSnapshot,
  type OptionDefinitionCache,
  type OptionDefinitionCacheEntry,
  type OptionDefinitionCacheKey,
  type OptionDiscoveryOptions,
  type DerivativeOrderGraphNode,
  type OptionDiscoveryTelemetry,
  type OptionSeriesReferenceEvidence,
  type OptionStrikeRange,
  type OptionChainSnapshotDiagnostics,
  type OptionChainSnapshotField,
  type OptionChainSnapshotQuote,
  type PriceHistoryContractCandidate,
  type PriceHistoryContractSelector,
  type PriceHistoryRequest,
  type PriceHistoryResult,
  type PriceHistorySecurityType,
  type PriceHistoryTelemetry,
  type TradingDiagnostics,
  type UnderlyingInstrumentReferenceEvidence,
} from "../src/index.js";

interface PackageManifest {
  version?: unknown;
  packageManager?: unknown;
  bin?: unknown;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

void test("public price-history types expose contract context and typed failures", () => {
  const securityType: PriceHistorySecurityType = "IND";
  const candidate: PriceHistoryContractCandidate = {
    conid: 416904,
    symbol: "SPX",
    securityType,
    exchange: null,
  };
  const selector: PriceHistoryContractSelector = {
    conid: 416904,
    assetClass: "IND",
    exchange: "CBOE",
  };
  const result = undefined as PriceHistoryResult | undefined;
  const telemetry = undefined as PriceHistoryTelemetry | undefined;
  const error = new IbkrPriceHistoryContractError("ambiguous", "CONTRACT_AMBIGUOUS");
  assert.equal(selector.conid, 416904);
  assert.equal(candidate.exchange, null);
  assert.equal(result?.contract.exchange ?? null, null);
  assert.equal(telemetry?.barSize ?? null, null);
  assert.equal(error.code, "CONTRACT_AMBIGUOUS");
});

void test("public option-chain snapshot types preserve nullable provider data", () => {
  const field: OptionChainSnapshotField = "delta";
  const quote = undefined as OptionChainSnapshotQuote | undefined;
  const diagnostics = undefined as OptionChainSnapshotDiagnostics | undefined;
  const snapshot = undefined as OptionChainSnapshot | undefined;
  const getSnapshot: IbkrClient["getOptionChainSnapshot"] | undefined = undefined;

  assert.equal(field, "delta");
  assert.equal(quote?.bid ?? null, null);
  assert.equal(diagnostics?.qualifiedCount ?? null, null);
  assert.equal(snapshot?.quotes.length ?? 0, 0);
  assert.equal(getSnapshot, undefined);
});

void test("public price-history recovery exposes typed boundary evidence", () => {
  const request: PriceHistoryRequest = { symbol: "SPX", days: 220 };
  const telemetry: IbkrRequestTelemetry = {
    event: "HISTORY_WINDOW_FALLBACK",
    endpoint: "iserver/marketdata",
    attempt: 1,
    delayMs: 0,
  };
  const error = new IbkrInsufficientHistoryError("SPX", 1, 2, null, null);
  assert.equal(request.days, 220);
  assert.equal(telemetry.event, "HISTORY_WINDOW_FALLBACK");
  assert.equal(error.availableStart, null);
});

void test("public request pacing types expose safe effective rate data", () => {
  const options: IbkrRequestSchedulerOptions = { secdefInfoMinStartIntervalMs: 250 };
  const telemetry: IbkrRequestTelemetry = {
    event: "SECDEF_INFO_PACING",
    endpoint: "secdef/info",
    attempt: 0,
    delayMs: 250,
    effectiveMinStartIntervalMs: 250,
  };
  assert.equal(options.secdefInfoMinStartIntervalMs, 250);
  assert.equal(telemetry.effectiveMinStartIntervalMs, 250);
});

void test("public option discovery options expose standard abort signals and a strike band", () => {
  const controller = new AbortController();
  const range: OptionStrikeRange = { min: 6800, max: 7400 };
  const options: OptionDiscoveryOptions = { signal: controller.signal, strikeRange: range };
  assert.equal(options.signal, controller.signal);
  assert.equal(options.strikeRange?.min, 6800);
  assert.equal(options.strikeRange?.max, 7400);
});

void test("public option telemetry exposes safe phase counts", () => {
  const telemetry: OptionDiscoveryTelemetry = {
    event: "OPTION_DISCOVERY_PHASE",
    phase: "DEFINITIONS",
    symbol: "SPX",
    month: "AUG26",
    right: "C",
    durationMs: 20,
    definitionRequestCount: 4,
    snapshotBatchCount: 0,
    listedStrikeCount: 900,
    selectedStrikeCount: 40,
    cachedDefinitionCount: 36,
  };
  assert.equal(telemetry.definitionRequestCount, 4);
  assert.equal(telemetry.listedStrikeCount, 900);
  assert.equal(telemetry.selectedStrikeCount, 40);
  assert.equal(telemetry.cachedDefinitionCount, 36);
});

void test("public option definition cache carries identity only", () => {
  const key: OptionDefinitionCacheKey = {
    underlyingConid: 416904,
    month: "SEP26",
    right: "P",
    strike: 7000,
  };
  const entry: OptionDefinitionCacheEntry = {
    key,
    contracts: [
      {
        conid: 777,
        symbol: "SPXW  260918P07000000",
        underlying: "SPX",
        tradingClass: "SPXW",
        expiry: "2026-09-18",
        strike: 7000,
        right: "P",
      },
    ],
  };
  const cache: OptionDefinitionCache = {
    get: (keys) => Promise.resolve(keys.map(() => null)),
    set: () => Promise.resolve(),
  };
  const clientOptions: IbkrClientOptions = { optionDefinitionCache: cache };

  assert.equal(entry.contracts[0]?.conid, 777);
  assert.equal(clientOptions.optionDefinitionCache, cache);
  assert.ok(!Object.keys(entry.contracts[0] ?? {}).includes("bid"));
});

void test("public graph nodes preserve explicit and fallback clientOrderId", () => {
  const nodeFixture: DerivativeOrderGraphNode = {
    memberId: "entry",
    accountId: "U1",
    legs: [
      {
        contract: {
          conid: 1,
          assetClass: "OPT",
          underlying: "SPY",
          expiration: "2026-09-18",
          tradingClass: "SPY",
          exchange: "SMART",
          multiplier: 100,
          strike: 700,
          right: "P",
        },
        ratio: -1,
      },
      {
        contract: {
          conid: 2,
          assetClass: "OPT",
          underlying: "SPY",
          expiration: "2026-09-18",
          tradingClass: "SPY",
          exchange: "SMART",
          multiplier: 100,
          strike: 705,
          right: "P",
        },
        ratio: 1,
      },
    ],
    quantity: 1,
    priceEffect: "CREDIT",
    orderType: "LMT",
    limit: 1.2,
    tif: "DAY",
    session: "REGULAR",
  };
  const explicitNode: DerivativeOrderGraphNode = {
    ...nodeFixture,
    clientOrderId: "hg-explicit",
  };
  const fallbackNode: DerivativeOrderGraphNode = { ...nodeFixture };

  assert.equal(explicitNode.clientOrderId, "hg-explicit");
  assert.equal(fallbackNode.clientOrderId, undefined);
});

void test("public account balance types expose nullable totals and margin snapshots", () => {
  const unavailableTotals: Pick<
    AccountBalances,
    "netLiquidation" | "availableFunds" | "buyingPower" | "cashBalance"
  > = {
    netLiquidation: null,
    availableFunds: null,
    buyingPower: null,
    cashBalance: null,
  };
  const balance = undefined as AccountBalances | undefined;
  const excessLiquidity: number | null = balance?.margin.securities.excessLiquidity ?? null;

  assert.equal(unavailableTotals.netLiquidation, null);
  assert.equal(excessLiquidity, null);
});

void test("public quote types expose snapshot-only requests", () => {
  const options: BrokerQuoteOptions = { includeHistory: false };
  const requests: readonly BrokerQuoteRequest[] = [{ symbol: "SPX", brokerId: "416904" }];
  const getQuotes: BrokerClient["getQuotes"] | undefined = undefined;

  assert.equal(options.includeHistory, false);
  assert.equal(requests[0]?.symbol, "SPX");
  assert.equal(getQuotes, undefined);
});

void test("public settlement types state one figure currency and one observation instant", () => {
  const figure: AccountSettlementFigure = { amount: 25_000.5, currency: "USD" };
  const settled: readonly AccountSettledCashByDate[] = [
    { settlementDate: "20260902", amount: 25_000.5 },
  ];
  const evidence: AccountSettlementEvidence = {
    accountId: "U123",
    observedAtEpochMillis: 1_754_000_000_000,
    settledCashByDate: settled,
    settledCashByDateRaw: "20260902:25000.50",
    availableFunds: { amount: null, currency: null },
    totalCashValue: figure,
    accruedCash: figure,
    excessLiquidity: figure,
    buyingPower: figure,
    netLiquidation: figure,
    accountType: "INDIVIDUAL",
    tradingType: "PMRGN",
    presentSummaryFieldNames: ["availablefunds", "settledcashbydate"],
  };
  const read: IbkrClient["getAccountSettlementEvidence"] | undefined = undefined;

  assert.equal(evidence.totalCashValue.currency, "USD");
  assert.equal(evidence.settledCashByDate[0]?.settlementDate, "20260902");
  assert.equal(evidence.settledCashByDateRaw, "20260902:25000.50");
  assert.equal(evidence.accountType, "INDIVIDUAL");
  assert.equal(evidence.availableFunds.amount, null);
  assert.equal(read, undefined);
});

void test("public contract transaction types state broker prose without classifying it", () => {
  const record: ContractTransactionRecord = {
    conid: 726,
    accountId: "U123",
    date: "Mon Sep 21 00:00:00 EDT 2026",
    rawDate: "20260921",
    type: "Assignment",
    description: "ASSIGNED PUT",
    currency: "USD",
    amount: -36_000,
    quantity: -1,
    price: 0,
    fxRate: 1,
    presentFieldNames: ["amt", "conid", "type"],
  };
  const evidence: ContractTransactionEvidence = {
    accountId: "U123",
    observedAtEpochMillis: 1_754_000_000_000,
    requestedConids: [726],
    requestedCurrency: "USD",
    requestedDays: 30,
    transactions: [record, { ...record, conid: null, type: null, amount: null }],
  };
  const read: IbkrClient["getContractTransactionEvidence"] | undefined = undefined;

  // A stated zero and an unstated field are different facts at the type level too.
  assert.equal(evidence.transactions[0]?.price, 0);
  assert.equal(evidence.transactions[1]?.amount, null);
  assert.equal(evidence.transactions[0]?.type, "Assignment");
  assert.equal(evidence.requestedCurrency, "USD");
  assert.equal(read, undefined);
});

void test("public option-series reference states raw contract facts only", () => {
  const underlying: UnderlyingInstrumentReferenceEvidence = {
    requestedConid: 756733,
    observedAtEpochMillis: 1_754_000_000_000,
    conid: 756733,
    symbol: "SPY",
    localSymbol: "SPY",
    instrumentType: "STK",
    tradingClass: "SPY",
    underlyingConid: 0,
    multiplier: null,
    multiplierRaw: null,
    companyName: "SS SPDR S&P 500 ETF TRUST-US",
    currency: "USD",
    exchange: "SMART",
    listingExchange: null,
    validExchanges: "SMART,AMEX,ARCA",
    cfiCode: null,
    contractClarificationType: null,
    classifier: null,
    underlyingIssuer: null,
    description: null,
    presentFieldNames: ["con_id", "instrument_type"],
  };
  const base: IbkrContractReferenceEvidence = underlying;
  const option: OptionSeriesReferenceEvidence = {
    ...base,
    requestedConid: 904834942,
    conid: 904834942,
    localSymbol: "SPY   260904P00716000",
    instrumentType: "OPT",
    underlyingConid: 756733,
    multiplier: 100,
    multiplierRaw: "100",
    cfiCode: "OPXXXS",
    description: "SEP 04 '26 716 Put",
    right: "PUT",
    strike: 716,
    strikeRaw: "716.0",
    maturityDate: "20260904",
    expiryFull: "20260904",
    contractMonth: "202609",
  };
  const readOption: IbkrClient["getOptionSeriesReference"] | undefined = undefined;
  const readUnderlying: IbkrClient["getUnderlyingInstrumentReference"] | undefined = undefined;

  assert.equal(option.multiplierRaw, "100");
  assert.equal(option.tradingClass, "SPY");
  assert.equal(option.listingExchange, null);
  assert.equal(underlying.instrumentType, "STK");
  assert.equal(underlying.underlyingConid, 0);
  assert.equal(readOption, undefined);
  assert.equal(readUnderlying, undefined);
});

test("package exposes only the library and no CLI entry point", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as PackageManifest;

  assert.equal(typeof manifest.packageManager, "string");
  assert.match(manifest.packageManager as string, /^yarn@4\.\d+\.\d+$/);
  assert.equal(manifest.bin, undefined);
  for (const script of Object.values(manifest.scripts ?? {})) {
    assert.doesNotMatch(script, /(?:src|dist)\/cli(?:\/|\s|$)/);
  }
  assert.equal(manifest.dependencies?.["chalk"], undefined);
  assert.equal(manifest.dependencies?.["commander"], undefined);
});

void test("public What-If results always carry a known environment", () => {
  const environment = (result: DerivativeComboPreviewResult): BrokerEnvironment =>
    result.environment;

  assert.equal(typeof environment, "function");
});

void test("public cancellation results require explicit recovery handling", () => {
  const response: IbkrJsonEvidence = { error: "unknown state" };
  const evidence: DerivativeOrderCancellationEvidence = {
    message: null,
    accountId: null,
    orderId: null,
    error: "error: unknown state",
    response,
  };
  const result: DerivativeOrderCancellationResult = {
    state: "recovery_required",
    accountId: "U1",
    orderId: "1",
    reason: "IBKR returned cancellation error evidence",
    evidence,
  };

  assert.equal(result.state, "recovery_required");
  assert.equal(result.evidence.error, "error: unknown state");
});

void test("public legacy warning acknowledgements require explicit account identity", () => {
  const input: Parameters<DerivativeExecutionClient["acknowledgeOrderWarning"]>[0] = {
    accountId: "U1",
    replyId: "reply-1",
    confirmed: true,
  };

  const continuation: DerivativeContingentWarningContinuation = {
    accountId: "U1",
    replyId: "reply-2",
    parentClientOrderId: "parent-1",
  };

  assert.equal(input.accountId, "U1");
  assert.equal(continuation.accountId, "U1");
});

void test("public trading diagnostics preserve unknown connection evidence", () => {
  const diagnostics: TradingDiagnostics = {
    accountId: "U1",
    selectedAccountId: null,
    environment: null,
    authenticated: null,
    connected: null,
    competingSession: null,
    marketDataAvailable: null,
    advisoryAssetPermissions: [],
  };

  assert.equal(diagnostics.connected, null);
  assert.equal(diagnostics.environment, null);
});

void test("package exports the explicit session lifecycle contract", () => {
  const evidence: IbkrSessionEvidence = {
    authenticated: null,
    competing: null,
    connected: null,
    accountIds: null,
    selectedAccountId: null,
    isPaper: null,
  };
  const lifecycle = undefined as IbkrSessionLifecycleClient | undefined;
  const initialize: IbkrSessionLifecycleClient["initializeBrokerageSession"] | undefined =
    lifecycle?.initializeBrokerageSession;
  const renew: IbkrSessionLifecycleClient["renewBrokerageSession"] | undefined =
    lifecycle?.renewBrokerageSession;

  assert.equal(evidence.connected, null);
  assert.equal(initialize, undefined);
  assert.equal(renew, undefined);
});

void test("package exports structured HTTP error evidence", () => {
  const response: IbkrHttpErrorResponse = {
    status: 500,
    body: "Chart data unavailable",
    retryAfter: null,
  };
  const error = new IbkrHttpError("Response status 500", 500, response);
  assert.equal(error.status, 500);
  assert.equal(error.statusCode, 500);
  assert.equal(error.response, response);
});
