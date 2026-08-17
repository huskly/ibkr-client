import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient } from "../src/ibkr/ibkrClient.js";
import { normalizeOptionContract } from "../src/ibkr/optionContract.js";
import type { IbkrOauth1Config } from "../src/ibkr/oauthConfig.js";

interface RequestInput {
  path: string;
  params?: Record<string, string | number | boolean | null | undefined>;
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

class FakeIbkrClient extends IbkrClient {
  readonly calls: RequestInput[] = [];

  constructor(private readonly responder: (input: RequestInput) => unknown) {
    super(config, { requestScheduler: { secdefInfoMinStartIntervalMs: 0 } });
  }

  protected override sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    return Promise.resolve(this.responder(input) as T);
  }

  protected override wait(_ms: number): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * The observed SPX case: one underlying, one expiry, one strike, one right, two listing classes.
 * The weekly is PM-settled and the monthly is AM-settled, so they are two products.
 */
function twoListingsResponder(input: RequestInput): unknown {
  if (input.path === "iserver/secdef/search") {
    return [{ conid: 416904, symbol: "SPX", sections: [{ secType: "OPT" }] }];
  }
  if (input.path === "iserver/secdef/strikes") return { call: [], put: [7000] };
  if (input.path === "iserver/secdef/info") {
    return [
      {
        conid: 782403981,
        symbol: "SPX",
        tradingClass: "SPX",
        secType: "OPT",
        maturityDate: "20260917",
        right: "P",
        strike: 7000,
      },
      {
        conid: 909968540,
        symbol: "SPX",
        tradingClass: "SPXW",
        secType: "OPT",
        maturityDate: "20260917",
        right: "P",
        strike: 7000,
      },
    ];
  }
  throw new Error(`Unexpected request: ${input.path}`);
}

void test("two listing classes of one contract are two identities, not one", () => {
  const monthly = normalizeOptionContract({
    conid: 782403981,
    symbol: "SPX",
    tradingClass: "SPX",
    maturityDate: "20260917",
    right: "P",
    strike: 7000,
  });
  const weekly = normalizeOptionContract({
    conid: 909968540,
    symbol: "SPX",
    tradingClass: "SPXW",
    maturityDate: "20260917",
    right: "P",
    strike: 7000,
  });

  assert.equal(monthly?.symbol, "SPX   260917P07000000");
  assert.equal(weekly?.symbol, "SPXW  260917P07000000");
  assert.notEqual(monthly?.symbol, weekly?.symbol);
  assert.equal(monthly?.underlying, "SPX");
  assert.equal(weekly?.underlying, "SPX", "the underlying is the index for both");
  assert.equal(weekly?.tradingClass, "SPXW");
});

void test("a definition with no listing class keeps the identity of its underlying", () => {
  const contract = normalizeOptionContract({
    conid: 123,
    symbol: "IWM",
    maturityDate: "20260911",
    right: "P",
    strike: 281,
  });

  assert.equal(contract?.symbol, "IWM   260911P00281000");
  assert.equal(contract?.tradingClass, "IWM");
});

void test("an exact request names the listing class it wants", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/marketdata/snapshot") {
      return [{ conid: 909968540, "84": "10.0", "86": "10.4", "7308": "-0.10" }];
    }
    return twoListingsResponder(input);
  });

  const quote = await client.getOptionQuote({
    symbol: "SPX",
    expiry: "2026-09-17",
    strike: 7000,
    right: "P",
    tradingClass: "SPXW",
  });

  assert.equal(quote?.conid, 909968540);
  assert.equal(quote?.tradingClass, "SPXW");
  assert.equal(quote?.symbol, "SPXW  260917P07000000");
});

void test("an exact request without a listing class still refuses to guess between two", async () => {
  const client = new FakeIbkrClient(twoListingsResponder);

  await assert.rejects(
    client.getOptionQuote({ symbol: "SPX", expiry: "2026-09-17", strike: 7000, right: "P" }),
    /ambiguous option definitions for SPX 2026-09-17; listing classes: SPX, SPXW\. Name one in 'tradingClass'/
  );
});

void test("one class is resolved once for each class, never shared between them", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/marketdata/snapshot") {
      return [
        { conid: 782403981, "84": "9.0", "86": "9.4", "7308": "-0.09" },
        { conid: 909968540, "84": "10.0", "86": "10.4", "7308": "-0.10" },
      ];
    }
    return twoListingsResponder(input);
  });

  const monthly = await client.getOptionQuote({
    symbol: "SPX",
    expiry: "2026-09-17",
    strike: 7000,
    right: "P",
    tradingClass: "SPX",
  });
  const weekly = await client.getOptionQuote({
    symbol: "SPX",
    expiry: "2026-09-17",
    strike: 7000,
    right: "P",
    tradingClass: "SPXW",
  });

  assert.equal(monthly?.conid, 782403981);
  assert.equal(weekly?.conid, 909968540);
});

void test("a chain keeps both listings as separate contracts", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/marketdata/snapshot") {
      return [
        { conid: 782403981, "84": "9.0", "86": "9.4", "7308": "-0.09" },
        { conid: 909968540, "84": "10.0", "86": "10.4", "7308": "-0.10" },
      ];
    }
    return twoListingsResponder(input);
  });

  const chain = await client.getOptionChain("SPX", "2026-09-17", "P");

  assert.deepEqual(
    chain
      .map(({ conid, tradingClass, symbol }) => ({ conid, tradingClass, symbol }))
      .sort((a, b) => a.conid - b.conid),
    [
      { conid: 782403981, tradingClass: "SPX", symbol: "SPX   260917P07000000" },
      { conid: 909968540, tradingClass: "SPXW", symbol: "SPXW  260917P07000000" },
    ]
  );
});
