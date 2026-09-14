import assert from "node:assert/strict";
import test from "node:test";
import { IbkrClient } from "../src/index.js";
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
    super(config);
  }

  protected override sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    return Promise.resolve(this.responder(input) as T);
  }
}

const listing = (contracts: unknown[]) => ({
  IBIT: [{ name: "ISHARES BITCOIN TRUST ETF", assetClass: "STK", contracts }],
});

const reference = {
  con_id: 320227571,
  symbol: "IBIT",
  instrument_type: "STK",
  currency: "USD",
  exchange: "SMART",
  valid_exchanges: "SMART,NASDAQ,ARCA",
};

function client(search: unknown, details: unknown = reference): FakeIbkrClient {
  return new FakeIbkrClient(({ path }) => {
    if (path === "trsrv/stocks") return search;
    if (path === "iserver/contract/320227571/info") return details;
    throw new Error(`Unexpected request: ${path}`);
  });
}

void test("resolves one exact US stock and verifies its contract details", async () => {
  const api = client(listing([{ conid: 320227571, exchange: "NASDAQ", isUS: true }]));
  assert.deepEqual(await api.resolveEquityContract(" ibit "), {
    conid: 320227571,
    assetClass: "STK",
    symbol: "IBIT",
    exchange: "SMART",
    primaryExchange: "NASDAQ",
    currency: "USD",
  });
  assert.deepEqual(api.calls, [
    { path: "trsrv/stocks", params: { symbols: "IBIT" } },
    { path: "iserver/contract/320227571/info" },
  ]);
});

void test("fails closed before details when US listing evidence is empty or ambiguous", async () => {
  const cases: unknown[] = [
    {},
    listing([]),
    listing([{ conid: 320227571, exchange: "NASDAQ", isUS: false }]),
    listing([{ conid: 320227571, exchange: "NASDAQ" }]),
    listing([
      { conid: 320227571, exchange: "NASDAQ", isUS: true },
      { conid: 999, exchange: "NYSE", isUS: true },
    ]),
    { IBIT: [{ name: "x", assetClass: "OPT", contracts: [] }] },
  ];
  for (const search of cases) {
    const api = client(search);
    await assert.rejects(() => api.resolveEquityContract("IBIT"), /exact US equity/i);
    assert.equal(api.calls.length, 1);
  }
});

void test("fails closed on incomplete or conflicting contract details", async () => {
  const search = listing([{ conid: 320227571, exchange: "NASDAQ", isUS: true }]);
  const cases: unknown[] = [
    null,
    {},
    { ...reference, con_id: 999 },
    { ...reference, symbol: "IBTC" },
    { ...reference, instrument_type: "OPT" },
    { ...reference, currency: "CAD" },
    { ...reference, exchange: "NASDAQ" },
    { ...reference, valid_exchanges: "NASDAQ,ARCA" },
  ];
  for (const details of cases) {
    await assert.rejects(() => client(search, details).resolveEquityContract("IBIT"), /contract/i);
  }
});

void test("rejects an unusable symbol before broker access", async () => {
  const api = client(listing([]));
  await assert.rejects(() => api.resolveEquityContract("  "), /symbol/i);
  assert.equal(api.calls.length, 0);
});
