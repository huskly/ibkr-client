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

class FakeIbkrClient extends IbkrClient {
  readonly calls: RequestInput[] = [];

  constructor(private readonly responder: (input: RequestInput, calls: RequestInput[]) => unknown) {
    super(config);
  }

  protected override req<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    return Promise.resolve(this.responder(input, this.calls) as T);
  }

  protected override wait(_ms: number): Promise<void> {
    return Promise.resolve();
  }
}

function discoveryResponse(input: RequestInput): unknown {
  if (input.path === "iserver/secdef/search") {
    return [{ conid: 272110, symbol: "MSTR", sections: [{ secType: "OPT" }] }];
  }
  if (input.path === "iserver/secdef/strikes") return { call: [215], put: [95] };
  if (input.path === "iserver/secdef/info") {
    const right = input.params?.["right"];
    if (right === "C") {
      return [
        { conid: 101, symbol: "MSTR", maturityDate: "20260814", right: "C", strike: 215 },
        { conid: 102, symbol: "MSTR", maturityDate: "20260821", right: "C", strike: 215 },
      ];
    }
    return [{ conid: 103, symbol: "MSTR", maturityDate: "20260814", right: "P", strike: 95 }];
  }
  throw new Error(`Unexpected request: ${input.path}`);
}

void test("option discovery primes search, preserves weekly/monthly expiries, and prices exact chain", async () => {
  let snapshotReads = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path !== "iserver/marketdata/snapshot") return discoveryResponse(input);
    snapshotReads += 1;
    if (snapshotReads === 1) return [];
    return [
      { conid: 101, "84": "4.00", "86": "4.20", "7308": "0.25" },
      { conid: 103, "84": "1.00", "86": "1.20", "7308": "-0.10" },
    ];
  });

  const chain = await client.getOptionChain("mstr", "2026-08-14");
  assert.deepEqual(
    chain.map(({ conid, symbol, expiry, right, bid, ask, mid, delta }) => ({
      conid,
      symbol,
      expiry,
      right,
      bid,
      ask,
      mid,
      delta,
    })),
    [
      {
        conid: 101,
        symbol: "MSTR  260814C00215000",
        expiry: "2026-08-14",
        right: "C",
        bid: 4,
        ask: 4.2,
        mid: 4.1,
        delta: 0.25,
      },
      {
        conid: 103,
        symbol: "MSTR  260814P00095000",
        expiry: "2026-08-14",
        right: "P",
        bid: 1,
        ask: 1.2,
        mid: 1.1,
        delta: -0.1,
      },
    ]
  );
  const searchIndex = client.calls.findIndex((call) => call.path === "iserver/secdef/search");
  const strikesIndex = client.calls.findIndex((call) => call.path === "iserver/secdef/strikes");
  assert.ok(searchIndex >= 0 && searchIndex < strikesIndex);

  const expiries = await client.getOptionExpiries("MSTR", "C", "2026-08-01", "2026-08-31");
  assert.deepEqual(expiries, ["2026-08-14", "2026-08-21"]);
  assert.equal(
    client.calls.filter((call) => call.path === "iserver/secdef/search").length,
    1,
    "the month discovery is memoized for this client/run"
  );
});

void test("an empty post-prime strikes response rejects instead of masquerading as no candidates", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 272110, symbol: "MSTR", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/strikes") return { call: [], put: [] };
    throw new Error(`Unexpected request: ${input.path}`);
  });
  await assert.rejects(
    () => client.getOptionChain("MSTR", "2026-08-14"),
    /empty option strikes.*after secdef\/search priming/
  );
});

void test("missing option delta fails closed", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path !== "iserver/marketdata/snapshot") return discoveryResponse(input);
    snapshots += 1;
    return snapshots === 1 ? [] : [{ conid: 102, "84": "4", "86": "4.2" }];
  });
  await assert.rejects(
    () =>
      client.getOptionQuote({
        symbol: "MSTR",
        expiry: "2026-08-21",
        strike: 215,
        right: "C",
      }),
    /bid\/ask\/delta required/
  );
});

void test("conid details normalize back to canonical OSI", async () => {
  const client = new FakeIbkrClient((input) => {
    assert.equal(input.path, "trsrv/secdef");
    return {
      "893911238": {
        conid: 893911238,
        symbol: "STRC",
        expiry: "20260821",
        putOrCall: "P",
        strike: "95",
      },
    };
  });
  assert.deepEqual(await client.getOptionContract(893911238), {
    conid: 893911238,
    symbol: "STRC  260821P00095000",
    underlying: "STRC",
    expiry: "2026-08-21",
    strike: 95,
    right: "P",
  });
});

void test("price history resolves the contract and normalizes OHLCV", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "trsrv/stocks") {
      return { MSTR: [{ assetClass: "STK", contracts: [{ conid: 272110, exchange: "NASDAQ" }] }] };
    }
    if (input.path === "iserver/marketdata/history") {
      assert.equal(input.params?.["period"], "220d");
      return {
        volumeFactor: 100,
        data: [{ t: 1, o: 100, h: 110, l: 90, c: 105, v: 12 }],
      };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });
  assert.deepEqual(await client.getPriceHistory({ symbol: "MSTR", days: 220 }), [
    { datetime: 1, open: 100, high: 110, low: 90, close: 105, volume: 1200 },
  ]);
});

void test("OSI getQuotes resolves the option conid before requesting a snapshot", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/marketdata/snapshot") {
      snapshots += 1;
      return snapshots === 1 ? [] : [{ conid: 102, "31": "4.10", "84": "4", "86": "4.2" }];
    }
    if (input.path === "iserver/marketdata/history") return { data: [] };
    return discoveryResponse(input);
  });
  const symbol = "MSTR  260821C00215000";
  const quotes = await client.getQuotes([symbol]);
  assert.equal(quotes[symbol]?.quote.lastPrice, 4.1);
  assert.equal(
    client.calls.some(
      (call) => call.path === "iserver/marketdata/snapshot" && call.params?.["conids"] === "102"
    ),
    true
  );
});
