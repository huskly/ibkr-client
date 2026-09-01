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
    settledcash: { amount: 25_000.5, currency: "USD" },
    availablefunds: { amount: 8_000, currency: "USD" },
    totalcashvalue: { amount: 26_000, currency: "USD" },
    accruedcash: { amount: 12.34, currency: "USD" },
    excessliquidity: { amount: 7_500, currency: "USD" },
    buyingpower: { amount: 32_000, currency: "USD" },
    netliquidation: { amount: 12_000, currency: "USD" },
  });

  assert.deepEqual(await client.getAccountSettlementEvidence(), {
    accountId: "U123",
    observedAtEpochMillis: PINNED_NOW,
    settledCash: { amount: 25_000.5, currency: "USD" },
    availableFunds: { amount: 8_000, currency: "USD" },
    totalCashValue: { amount: 26_000, currency: "USD" },
    accruedCash: { amount: 12.34, currency: "USD" },
    excessLiquidity: { amount: 7_500, currency: "USD" },
    buyingPower: { amount: 32_000, currency: "USD" },
    netLiquidation: { amount: 12_000, currency: "USD" },
    presentSummaryFieldNames: [
      "accruedcash",
      "availablefunds",
      "buyingpower",
      "excessliquidity",
      "netliquidation",
      "settledcash",
      "totalcashvalue",
    ],
  });
  assert.deepEqual(
    client.calls.map((call) => call.path),
    ["portfolio/accounts", "portfolio/U123/summary"]
  );
});

void test("an absent settled cash field reports null amount and null currency", async () => {
  const client = clientForSummary({
    availablefunds: { amount: 8_000, currency: "USD" },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.settledCash, { amount: null, currency: null });
  assert.deepEqual(evidence.totalCashValue, { amount: null, currency: null });
  assert.deepEqual(evidence.availableFunds, { amount: 8_000, currency: "USD" });
  assert.deepEqual(evidence.presentSummaryFieldNames, ["availablefunds"]);
});

void test("an empty summary never throws and reports every figure as unavailable", async () => {
  const client = clientForSummary({});

  assert.deepEqual(await client.getAccountSettlementEvidence(), {
    accountId: "U123",
    observedAtEpochMillis: PINNED_NOW,
    settledCash: { amount: null, currency: null },
    availableFunds: { amount: null, currency: null },
    totalCashValue: { amount: null, currency: null },
    accruedCash: { amount: null, currency: null },
    excessLiquidity: { amount: null, currency: null },
    buyingPower: { amount: null, currency: null },
    netLiquidation: { amount: null, currency: null },
    presentSummaryFieldNames: [],
  });
});

void test("a thousands-separated string amount parses to a number", async () => {
  const client = clientForSummary({
    settledcash: { amount: "1,234,567.89", currency: "USD" },
    totalcashvalue: { amount: "4,000", currency: "USD" },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.settledCash, { amount: 1_234_567.89, currency: "USD" });
  assert.deepEqual(evidence.totalCashValue, { amount: 4_000, currency: "USD" });
});

void test("an unusable amount reports null instead of a guessed number", async () => {
  const client = clientForSummary({
    settledcash: { amount: "x123", currency: "USD" },
    availablefunds: { amount: Number.NaN, currency: "USD" },
    totalcashvalue: { amount: Number.POSITIVE_INFINITY, currency: "USD" },
    accruedcash: { currency: "USD" },
    excessliquidity: { amount: "1,2,3", currency: "USD" },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.equal(evidence.settledCash.amount, null);
  assert.equal(evidence.availableFunds.amount, null);
  assert.equal(evidence.totalCashValue.amount, null);
  assert.equal(evidence.accruedCash.amount, null);
  assert.equal(evidence.excessLiquidity.amount, null);
  assert.equal(evidence.settledCash.currency, "USD");
});

void test("a non-USD currency is kept verbatim and is never rewritten", async () => {
  const client = clientForSummary({
    settledcash: { amount: 4_200, currency: "EUR" },
    availablefunds: { amount: 900, currency: "chf" },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.settledCash, { amount: 4_200, currency: "EUR" });
  assert.deepEqual(evidence.availableFunds, { amount: 900, currency: "chf" });
});

void test("a missing currency stays null and is never defaulted to USD", async () => {
  const client = clientForSummary({
    settledcash: { amount: 4_200 },
    availablefunds: { amount: 900, currency: "  " },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.equal(evidence.settledCash.currency, null);
  assert.equal(evidence.availableFunds.currency, null);
});

void test("a summary entry that is not an object reports an unavailable figure", async () => {
  const client = clientForSummary({
    settledcash: null,
    availablefunds: "8000",
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.settledCash, { amount: null, currency: null });
  assert.deepEqual(evidence.availableFunds, { amount: null, currency: null });
  assert.deepEqual(evidence.presentSummaryFieldNames, ["availablefunds", "settledcash"]);
});

void test("present summary field names are sorted names only, never values", async () => {
  const client = clientForSummary({
    totalcashvalue: { amount: 26_000, currency: "USD" },
    settledcash: { amount: 25_000, currency: "USD" },
    "equitywithloanvalue-s": { amount: 10_000, currency: "USD" },
    accruedcash: { amount: 12, currency: "USD" },
  });

  const evidence = await client.getAccountSettlementEvidence();
  assert.deepEqual(evidence.presentSummaryFieldNames, [
    "accruedcash",
    "equitywithloanvalue-s",
    "settledcash",
    "totalcashvalue",
  ]);
  const serialized = JSON.stringify(evidence.presentSummaryFieldNames);
  assert.equal(serialized.includes("25000"), false);
  assert.equal(serialized.includes("USD"), false);
});

void test("the observation names the account the figures were read for", async () => {
  const client = clientForSummary({ settledcash: { amount: 1, currency: "USD" } }, "U987654");

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
});
