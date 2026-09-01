import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient } from "../src/ibkr/ibkrClient.js";
import type { IbkrOauth1Config } from "../src/ibkr/oauthConfig.js";

interface RequestInput {
  path: string;
  method?: string;
  params?: Record<string, string | number | boolean | null | undefined>;
  data?: object;
}

const config: IbkrOauth1Config = {
  accessTokenSecret: "test",
  accessToken: "test",
  consumerKey: "test",
  encryption: "test",
  signature: "test",
  dhPrime: "test",
  realm: "test",
};

const PINNED_NOW = 1_754_000_000_000;

class FakeIbkrClient extends IbkrClient {
  readonly calls: RequestInput[] = [];

  constructor(private readonly responder: (input: RequestInput) => unknown) {
    super(config);
  }

  protected override sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    return Promise.resolve(this.responder(input) as T);
  }

  protected override wait(_ms: number): Promise<void> {
    return Promise.resolve();
  }

  protected override now(): number {
    return PINNED_NOW;
  }
}

function clientForSummary(summary: object, accountId = "U123"): FakeIbkrClient {
  return new FakeIbkrClient((input) => {
    if (input.path === "portfolio/accounts") return [{ accountId }];
    if (input.path === `portfolio/${accountId}/summary`) return summary;
    throw new Error(`Unexpected request: ${input.path}`);
  });
}

void test("getAccountSettlementEvidence states every figure with its own currency", async () => {
  const client = clientForSummary({
    settledcashbydate: {
      amount: 0,
      currency: null,
      value: "20260902:12345.67",
      isNull: false,
      severity: 0,
      timestamp: 1_756_000_000_000,
    },
    availablefunds: { amount: 8_000, currency: "USD", value: null, isNull: false, severity: 0 },
    totalcashvalue: { amount: 26_000, currency: "USD", value: null, isNull: false, severity: 0 },
    accruedcash: { amount: 12.34, currency: "USD", value: null, isNull: false, severity: 0 },
    excessliquidity: { amount: 7_500, currency: "USD", value: null, isNull: false, severity: 0 },
    buyingpower: { amount: 32_000, currency: "USD", value: null, isNull: false, severity: 0 },
    netliquidation: { amount: 12_000, currency: "USD", value: null, isNull: false, severity: 0 },
    accounttype: { amount: 0, currency: null, value: "INDIVIDUAL" },
    "tradingtype-s": { amount: 0, currency: null, value: "PMRGN" },
  });

  assert.deepEqual(await client.getAccountSettlementEvidence(), {
    accountId: "U123",
    observedAtEpochMillis: PINNED_NOW,
    settledCashByDate: [{ settlementDate: "20260902", amount: 12_345.67 }],
    settledCashByDateRaw: "20260902:12345.67",
    availableFunds: { amount: 8_000, currency: "USD" },
    totalCashValue: { amount: 26_000, currency: "USD" },
    accruedCash: { amount: 12.34, currency: "USD" },
    excessLiquidity: { amount: 7_500, currency: "USD" },
    buyingPower: { amount: 32_000, currency: "USD" },
    netLiquidation: { amount: 12_000, currency: "USD" },
    accountType: "INDIVIDUAL",
    tradingType: "PMRGN",
    presentSummaryFieldNames: [
      "accounttype",
      "accruedcash",
      "availablefunds",
      "buyingpower",
      "excessliquidity",
      "netliquidation",
      "settledcashbydate",
      "totalcashvalue",
      "tradingtype-s",
    ],
  });
  assert.deepEqual(
    client.calls.map((call) => call.path),
    ["portfolio/accounts", "portfolio/U123/summary"]
  );
});

void test("several settled-cash pairs in one string keep the order the broker used", async () => {
  const client = clientForSummary({
    settledcashbydate: {
      amount: 0,
      currency: null,
      value: "20260902:12345.67;20260903:250.00;20260904:-75.5",
    },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.settledCashByDate, [
    { settlementDate: "20260902", amount: 12_345.67 },
    { settlementDate: "20260903", amount: 250 },
    { settlementDate: "20260904", amount: -75.5 },
  ]);
  assert.equal(evidence.settledCashByDateRaw, "20260902:12345.67;20260903:250.00;20260904:-75.5");
});

void test("a comma also separates settled-cash pairs", async () => {
  const client = clientForSummary({
    settledcashbydate: { amount: 0, currency: null, value: "20260902:100.25,20260903:200.75" },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.settledCashByDate, [
    { settlementDate: "20260902", amount: 100.25 },
    { settlementDate: "20260903", amount: 200.75 },
  ]);
});

void test("a malformed settled-cash pair is skipped while the raw string survives", async () => {
  const client = clientForSummary({
    settledcashbydate: {
      amount: 0,
      currency: null,
      value: "20260902:12345.67;notadate:5;2026090:9;20260904:xyz;20260905",
    },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.settledCashByDate, [{ settlementDate: "20260902", amount: 12_345.67 }]);
  assert.equal(
    evidence.settledCashByDateRaw,
    "20260902:12345.67;notadate:5;2026090:9;20260904:xyz;20260905"
  );
});

void test("an absent settled-cash key gives an empty list and a null raw string", async () => {
  const client = clientForSummary({
    availablefunds: { amount: 8_000, currency: "USD", value: null },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.settledCashByDate, []);
  assert.equal(evidence.settledCashByDateRaw, null);
  assert.deepEqual(evidence.availableFunds, { amount: 8_000, currency: "USD" });
  assert.deepEqual(evidence.presentSummaryFieldNames, ["availablefunds"]);
});

void test("a settled-cash field with no value string reports an empty list", async () => {
  const client = clientForSummary({
    settledcashbydate: { amount: 0, currency: null, value: null, isNull: true },
    "settledcashbydate-s": { amount: 0, currency: null, value: "   " },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.settledCashByDate, []);
  assert.equal(evidence.settledCashByDateRaw, null);
});

void test("a numeric field carries an amount and a currency beside a null value", async () => {
  const client = clientForSummary({
    totalcashvalue: {
      amount: 26_000.42,
      currency: "USD",
      value: null,
      isNull: false,
      severity: 0,
      timestamp: 1_756_000_000_000,
    },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.totalCashValue, { amount: 26_000.42, currency: "USD" });
  assert.deepEqual(evidence.settledCashByDate, []);
});

void test("account type and trading type read the value string of their own key", async () => {
  const client = clientForSummary({
    accounttype: { amount: 0, currency: null, value: "INDIVIDUAL" },
    "tradingtype-s": { amount: 0, currency: null, value: "PMRGN" },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.equal(evidence.accountType, "INDIVIDUAL");
  assert.equal(evidence.tradingType, "PMRGN");
});

void test("an absent account type and trading type stay null", async () => {
  const client = clientForSummary({
    accounttype: { amount: 0, currency: null, value: "  " },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.equal(evidence.accountType, null);
  assert.equal(evidence.tradingType, null);
});

void test("an empty summary never throws and reports every figure as unavailable", async () => {
  const client = clientForSummary({});

  assert.deepEqual(await client.getAccountSettlementEvidence(), {
    accountId: "U123",
    observedAtEpochMillis: PINNED_NOW,
    settledCashByDate: [],
    settledCashByDateRaw: null,
    availableFunds: { amount: null, currency: null },
    totalCashValue: { amount: null, currency: null },
    accruedCash: { amount: null, currency: null },
    excessLiquidity: { amount: null, currency: null },
    buyingPower: { amount: null, currency: null },
    netLiquidation: { amount: null, currency: null },
    accountType: null,
    tradingType: null,
    presentSummaryFieldNames: [],
  });
});

void test("a thousands-separated string amount parses to a number", async () => {
  const client = clientForSummary({
    availablefunds: { amount: "1,234,567.89", currency: "USD" },
    totalcashvalue: { amount: "4,000", currency: "USD" },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.availableFunds, { amount: 1_234_567.89, currency: "USD" });
  assert.deepEqual(evidence.totalCashValue, { amount: 4_000, currency: "USD" });
});

void test("an unusable amount reports null instead of a guessed number", async () => {
  const client = clientForSummary({
    netliquidation: { amount: "x123", currency: "USD" },
    availablefunds: { amount: Number.NaN, currency: "USD" },
    totalcashvalue: { amount: Number.POSITIVE_INFINITY, currency: "USD" },
    accruedcash: { currency: "USD" },
    excessliquidity: { amount: "1,2,3", currency: "USD" },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.equal(evidence.netLiquidation.amount, null);
  assert.equal(evidence.availableFunds.amount, null);
  assert.equal(evidence.totalCashValue.amount, null);
  assert.equal(evidence.accruedCash.amount, null);
  assert.equal(evidence.excessLiquidity.amount, null);
  assert.equal(evidence.netLiquidation.currency, "USD");
});

void test("a non-USD currency is kept verbatim and is never rewritten", async () => {
  const client = clientForSummary({
    totalcashvalue: { amount: 4_200, currency: "EUR" },
    availablefunds: { amount: 900, currency: "chf" },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.totalCashValue, { amount: 4_200, currency: "EUR" });
  assert.deepEqual(evidence.availableFunds, { amount: 900, currency: "chf" });
});

void test("a missing currency stays null and is never defaulted to USD", async () => {
  const client = clientForSummary({
    totalcashvalue: { amount: 4_200 },
    availablefunds: { amount: 900, currency: "  " },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.equal(evidence.totalCashValue.currency, null);
  assert.equal(evidence.availableFunds.currency, null);
});

void test("a summary entry that is not an object reports an unavailable figure", async () => {
  const client = clientForSummary({
    settledcashbydate: null,
    totalcashvalue: null,
    availablefunds: "8000",
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.settledCashByDate, []);
  assert.equal(evidence.settledCashByDateRaw, null);
  assert.deepEqual(evidence.totalCashValue, { amount: null, currency: null });
  assert.deepEqual(evidence.availableFunds, { amount: null, currency: null });
  assert.deepEqual(evidence.presentSummaryFieldNames, [
    "availablefunds",
    "settledcashbydate",
    "totalcashvalue",
  ]);
});

void test("present summary field names are sorted names only, never values", async () => {
  const client = clientForSummary({
    totalcashvalue: { amount: 26_000, currency: "USD" },
    settledcashbydate: { amount: 0, currency: null, value: "20260902:25000.00" },
    "settledcashbydate-c": { amount: 0, currency: null, value: "20260902:0.00" },
    "equitywithloanvalue-s": { amount: 10_000, currency: "USD" },
    accruedcash: { amount: 12, currency: "USD" },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.presentSummaryFieldNames, [
    "accruedcash",
    "equitywithloanvalue-s",
    "settledcashbydate",
    "settledcashbydate-c",
    "totalcashvalue",
  ]);
  const serialized = JSON.stringify(evidence.presentSummaryFieldNames);
  assert.equal(serialized.includes("25000"), false);
  assert.equal(serialized.includes("USD"), false);
});

void test("the observation names the account the figures were read for", async () => {
  const client = clientForSummary(
    { settledcashbydate: { amount: 0, currency: null, value: "20260902:1.00" } },
    "U987654"
  );

  const evidence = await client.getAccountSettlementEvidence();
  assert.equal(evidence.accountId, "U987654");
  assert.equal(client.calls[1]?.path, "portfolio/U987654/summary");
});

void test("getAccountBalances stays unchanged beside the new evidence read", async () => {
  const client = clientForSummary({
    netliquidation: { amount: 12_000, currency: "USD" },
    availablefunds: { amount: 8_000, currency: "USD" },
    buyingpower: { amount: 32_000, currency: "USD" },
    totalcashvalue: { amount: 4_000, currency: "USD" },
  });

  const balances = await client.getAccountBalances();
  assert.equal(balances.netLiquidation, 12_000);
  assert.equal(balances.cashBalance, 4_000);
  assert.equal("settledCash" in balances, false);
  assert.equal("settledCashByDate" in balances, false);
});
