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

  protected override sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    return Promise.resolve(this.responder(input, this.calls) as T);
  }

  protected override wait(_ms: number): Promise<void> {
    return Promise.resolve();
  }
}

interface RateLimitedError extends Error {
  status: number;
  response?: {
    status: number;
    headers?: Record<string, string | string[]>;
  };
}

function rateLimitedError(retryAfter?: string): RateLimitedError {
  const error = new Error("Response status 429") as RateLimitedError;
  error.status = 429;
  error.response = {
    status: 429,
    ...(retryAfter ? { headers: { "Retry-After": retryAfter } } : {}),
  };
  return error;
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

void test("multi-month option discovery bounds secdef/info concurrency", async () => {
  let activeInfo = 0;
  let maxActiveInfo = 0;
  const observedInfo: string[] = [];

  const monthToDate = (month: string): string => {
    const year = Number(`20${month.slice(3)}`);
    const monthIndex = [
      "JAN",
      "FEB",
      "MAR",
      "APR",
      "MAY",
      "JUN",
      "JUL",
      "AUG",
      "SEP",
      "OCT",
      "NOV",
      "DEC",
    ].indexOf(month.slice(0, 3));
    return `${year}-${String(monthIndex + 1).padStart(2, "0")}-14`;
  };

  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 272110, symbol: "MSTR", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/strikes") {
      return { call: [15, 20, 25, 30, 35, 40, 45, 50, 55], put: [] };
    }
    if (input.path === "iserver/secdef/info") {
      const month = String(input.params?.["month"] ?? "UNK");
      const strike = Number(input.params?.["strike"] ?? 0);
      observedInfo.push(`info:${month}:${String(strike)}`);
      activeInfo += 1;
      maxActiveInfo = Math.max(maxActiveInfo, activeInfo);
      return new Promise((resolve) => {
        setTimeout(() => {
          const monthCode = month.replace(/\D/g, "");
          const conid = Number(`${monthCode}${String(strike).padStart(3, "0")}`);
          resolve([
            {
              conid,
              symbol: "MSTR",
              maturityDate: monthToDate(month).split("-").join(""),
              right: String(input.params?.["right"]),
              strike,
            },
          ]);
        }, 10);
      }).finally(() => {
        activeInfo -= 1;
      });
    }
    return discoveryResponse(input);
  });

  const expiries = await client.getOptionExpiries("MSTR", "C", "2026-07-01", "2026-09-30");
  assert.deepEqual(expiries, ["2026-07-14", "2026-08-14", "2026-09-14"]);
  assert.ok(
    maxActiveInfo <= 8,
    `expected bounded concurrent info requests, observed max ${String(maxActiveInfo)}`
  );

  const order = ["JUL26", "AUG26", "SEP26"].map((month) =>
    observedInfo.findIndex((entry) => entry.startsWith(`info:${month}:`))
  );
  assert.ok(order.every((index) => index >= 0));
  const [julyIndex, augustIndex, septemberIndex] = order;
  assert.ok(julyIndex >= 0 && augustIndex >= 0 && septemberIndex >= 0);
  assert.ok(julyIndex < augustIndex && augustIndex < septemberIndex);
});

void test("option chain skips incomplete contracts and returns usable quotes", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/info") {
      const right = input.params?.["right"];
      if (right === "C") {
        return [{ conid: 101, symbol: "MSTR", maturityDate: "20260814", right: "C", strike: 215 }];
      }
      return [{ conid: 102, symbol: "MSTR", maturityDate: "20260814", right: "P", strike: 95 }];
    }
    if (input.path !== "iserver/marketdata/snapshot") return discoveryResponse(input);
    snapshots += 1;
    if (snapshots === 1) return [];
    return [{ conid: 101, "84": "4.00", "86": "4.20", "7308": "0.25" }];
  });

  const chain = await client.getOptionChain("MSTR", "2026-08-14");
  assert.deepEqual(
    chain.map(({ conid, symbol, bid, ask, mid, delta }) => ({
      conid,
      symbol,
      bid,
      ask,
      mid,
      delta,
    })),
    [{ conid: 101, symbol: "MSTR  260814C00215000", bid: 4, ask: 4.2, mid: 4.1, delta: 0.25 }]
  );
});

void test("chain with all incomplete option snapshots fails noisily", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/info") {
      const right = input.params?.["right"];
      if (right === "C") {
        return [{ conid: 101, symbol: "MSTR", maturityDate: "20260814", right: "C", strike: 215 }];
      }
      return [{ conid: 102, symbol: "MSTR", maturityDate: "20260814", right: "P", strike: 95 }];
    }
    if (input.path !== "iserver/marketdata/snapshot") return discoveryResponse(input);
    snapshots += 1;
    if (snapshots === 1) return [];
    return [{ conid: 101, "84": "4.00", "86": "4.20" }];
  });
  await assert.rejects(
    () => client.getOptionChain("MSTR", "2026-08-14"),
    /unusable option market data/
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

void test("429 responses are retried and eventually succeed when status clears", async () => {
  let strikesCalls = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 272110, symbol: "MSTR", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/strikes") {
      strikesCalls += 1;
      if (strikesCalls === 1) throw rateLimitedError("1");
      return { call: [215], put: [] };
    }
    if (input.path === "iserver/secdef/info") {
      return [{ conid: 101, symbol: "MSTR", maturityDate: "20260814", right: "C", strike: 215 }];
    }
    if (input.path === "iserver/marketdata/snapshot") return [];
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await client.getOptionExpiries("MSTR", "C", "2026-08-01", "2026-08-31");
  assert.equal(strikesCalls, 2);
});

void test("exhausted 429 retries preserve the original read failure", async () => {
  let strikesCalls = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 272110, symbol: "MSTR", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/strikes") {
      strikesCalls += 1;
      throw rateLimitedError("1");
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  let caught: unknown;
  try {
    await client.getOptionExpiries("MSTR", "C", "2026-08-01", "2026-08-31");
    assert.fail("Expected the request to fail after exhausting retries");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "Response status 429");
  assert.equal(strikesCalls, 4);
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
