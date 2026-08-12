import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  IbkrHttpError,
  IbkrInsufficientHistoryError,
  IbkrPriceHistoryContractError,
  type AccountBalances,
  type BrokerClient,
  type BrokerQuoteOptions,
  type BrokerQuoteRequest,
  type IbkrClient,
  type IbkrHttpErrorResponse,
  type IbkrRequestTelemetry,
  type OptionChainSnapshot,
  type OptionChainSnapshotDiagnostics,
  type OptionChainSnapshotField,
  type OptionChainSnapshotQuote,
  type PriceHistoryContractCandidate,
  type PriceHistoryContractSelector,
  type PriceHistoryRequest,
  type PriceHistoryResult,
  type PriceHistorySecurityType,
  type PriceHistoryTelemetry,
} from "../src/index.js";

interface PackageManifest {
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

void test("public account balance types expose margin snapshots", () => {
  const balance = undefined as AccountBalances | undefined;
  const excessLiquidity: number | null = balance?.margin.securities.excessLiquidity ?? null;
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

test("package exposes only the library and no CLI entry point", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as PackageManifest;

  assert.equal(manifest.bin, undefined);
  for (const script of Object.values(manifest.scripts ?? {})) {
    assert.doesNotMatch(script, /(?:src|dist)\/cli(?:\/|\s|$)/);
  }
  assert.equal(manifest.dependencies?.["chalk"], undefined);
  assert.equal(manifest.dependencies?.["commander"], undefined);
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
