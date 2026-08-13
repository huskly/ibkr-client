import test from "node:test";
import assert from "node:assert/strict";
import {
  IbkrBrokerResponseError,
  IbkrClient,
  IbkrHttpError,
  IbkrInsufficientHistoryError,
  IbkrPriceHistoryContractError,
  type IbkrClientOptions,
} from "../src/ibkr/ibkrClient.js";
import { IbkrRequestSchedulerError } from "../src/ibkr/requestScheduler.js";
import type { IbkrOauth1Config } from "../src/ibkr/oauthConfig.js";

interface RequestInput {
  path: string;
  method?: string;
  params?: Record<string, string | number | boolean | null | undefined>;
  data?: object;
}

const TEST_NOW = Date.UTC(2026, 7, 31);

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

  constructor(
    private readonly responder: (input: RequestInput, calls: RequestInput[]) => unknown,
    options: IbkrClientOptions = {}
  ) {
    super(config, {
      ...options,
      requestScheduler: {
        secdefInfoMinStartIntervalMs: 0,
        ...options.requestScheduler,
      },
    });
  }

  protected override sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    return Promise.resolve(this.responder(input, this.calls) as T);
  }

  protected override wait(_ms: number): Promise<void> {
    return Promise.resolve();
  }

  protected override now(): number {
    return TEST_NOW;
  }
}

class InitFailureIbkrClient extends IbkrClient {
  constructor(error: Error) {
    super(config);
    (this as unknown as { raw: { init: () => Promise<never> } }).raw = {
      init: () => Promise.reject(error),
    };
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

function completeDailyHistory(days: number): unknown {
  return {
    data: [
      { t: TEST_NOW - (days - 1) * 86_400_000, o: 1, h: 2, l: 0, c: 1, v: 1 },
      { t: TEST_NOW, o: 2, h: 3, l: 1, c: 2, v: 2 },
    ],
  };
}

interface HttpResponseError extends Error {
  status: number;
  response: { status: number; data: unknown };
}

function httpResponseError(status: number, data: unknown): HttpResponseError {
  const error = new Error(`Response status ${String(status)}`) as HttpResponseError;
  error.status = status;
  error.response = { status, data };
  return error;
}

function historyContractInfo(input: RequestInput): unknown | undefined {
  if (input.path === "iserver/contract/416904/info") {
    return {
      con_id: 416904,
      local_symbol: "SPX",
      instrument_type: "IND",
      exchange: "CBOE",
    };
  }
  return undefined;
}

function historyWindow(input: RequestInput): { start: number; end: number } {
  const rawEnd = String(input.params?.["startTime"]);
  const end = Date.UTC(
    Number(rawEnd.slice(0, 4)),
    Number(rawEnd.slice(4, 6)) - 1,
    Number(rawEnd.slice(6, 8))
  );
  const periodDays = Number.parseInt(String(input.params?.["period"]), 10);
  return { start: end - (periodDays - 1) * 86_400_000, end };
}

function bar(
  t: number,
  value = 1
): { t: number; o: number; h: number; l: number; c: number; v: number } {
  return { t, o: value, h: value + 1, l: value - 1, c: value, v: value };
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
      {
        conid: 101,
        "84": "4.00",
        "86": "4.20",
        "7308": "0.25",
        "7638": "450",
        "7762": "120",
      },
      { conid: 103, "84": "1.00", "86": "1.20", "7308": "-0.10", "7638": 0, "7762": 0 },
    ];
  });

  const chain = await client.getOptionChain("mstr", "2026-08-14");
  assert.deepEqual(
    chain.map(({ conid, symbol, expiry, right, bid, ask, mid, delta, volume, openInterest }) => ({
      conid,
      symbol,
      expiry,
      right,
      bid,
      ask,
      mid,
      delta,
      volume,
      openInterest,
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
        volume: 120,
        openInterest: 450,
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
        volume: 0,
        openInterest: 0,
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

void test("failed option discovery is retried and preserves the original typed error", async () => {
  const failure = new IbkrBrokerResponseError("temporary broker failure", {
    message: "temporary broker failure",
    code: "TEMPORARY",
    statusCode: null,
    details: {},
  });
  let searchCalls = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      searchCalls += 1;
      if (searchCalls === 1) throw failure;
    }
    return discoveryResponse(input);
  });

  await assert.rejects(
    () => client.getOptionExpiries("MSTR", "C", "2026-08-01", "2026-08-31"),
    (error: unknown) => error === failure
  );
  assert.deepEqual(await client.getOptionExpiries("MSTR", "C", "2026-08-01", "2026-08-31"), [
    "2026-08-14",
    "2026-08-21",
  ]);
  assert.equal(searchCalls, 2, "the later call starts a new broker discovery");
});

void test("concurrent option discoveries coalesce and successful results stay cached", async () => {
  let resolveSearch: ((value: unknown) => void) | undefined;
  const search = new Promise<unknown>((resolve) => {
    resolveSearch = resolve;
  });
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") return search;
    return discoveryResponse(input);
  });

  const first = client.getOptionExpiries("MSTR", "C", "2026-08-01", "2026-08-31");
  const second = client.getOptionExpiries("mstr", "C", "2026-08-01", "2026-08-31");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(client.calls.filter(({ path }) => path === "iserver/secdef/search").length, 1);

  resolveSearch?.([{ conid: 272110, symbol: "MSTR", sections: [{ secType: "OPT" }] }]);
  assert.deepEqual(await Promise.all([first, second]), [
    ["2026-08-14", "2026-08-21"],
    ["2026-08-14", "2026-08-21"],
  ]);
  assert.deepEqual(await client.getOptionExpiries("MSTR", "C", "2026-08-01", "2026-08-31"), [
    "2026-08-14",
    "2026-08-21",
  ]);
  assert.equal(client.calls.filter(({ path }) => path === "iserver/secdef/search").length, 1);
});

void test("failed option discovery cannot delete a newer cache replacement", async () => {
  let rejectSearch: ((error: unknown) => void) | undefined;
  const search = new Promise<unknown>((_resolve, reject) => {
    rejectSearch = reject;
  });
  const failure = new IbkrBrokerResponseError("first discovery failed", {
    message: "first discovery failed",
    code: "TEMPORARY",
    statusCode: null,
    details: {},
  });
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") return search;
    return discoveryResponse(input);
  });
  const internals = client as unknown as {
    optionDiscovery: Map<string, Promise<unknown>>;
    discoverOptions(symbol: string, month: string, right: "C"): Promise<unknown>;
  };

  const first = internals.discoverOptions("MSTR", "AUG26", "C");
  const replacement = Promise.resolve({ contracts: [], malformedDefinitionCount: 0 });
  internals.optionDiscovery.set("MSTR:AUG26:C", replacement);
  rejectSearch?.(failure);

  await assert.rejects(first, (error: unknown) => error === failure);
  assert.equal(internals.optionDiscovery.get("MSTR:AUG26:C"), replacement);
});

void test("multi-month option discovery uses conservative secdef/info concurrency", async () => {
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
  assert.equal(maxActiveInfo, 1, "the conservative default secdef/info limit is one");
  assert.equal(observedInfo.length, 27, "each strike has exactly one definition request");

  const order = ["JUL26", "AUG26", "SEP26"].map((month) =>
    observedInfo.findIndex((entry) => entry.startsWith(`info:${month}:`))
  );
  const [julyIndex, augustIndex, septemberIndex] = order;
  if (julyIndex === undefined || augustIndex === undefined || septemberIndex === undefined) {
    assert.fail("Expected each option month to be discovered");
  }
  assert.ok(order.every((index) => index >= 0));
  assert.ok(julyIndex >= 0 && augustIndex >= 0 && septemberIndex >= 0);
  assert.ok(julyIndex < augustIndex && augustIndex < septemberIndex);
});

void test("exact-expiry option discovery filters the unused right and emits safe phase telemetry", async () => {
  const telemetry: unknown[] = [];
  let snapshotReads = 0;
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/secdef/search") {
        return [{ conid: 272110, symbol: "MSTR", sections: [{ secType: "OPT" }] }];
      }
      if (input.path === "iserver/secdef/strikes") return { call: [210, 215], put: [90, 95] };
      if (input.path === "iserver/secdef/info") {
        assert.equal(input.params?.["right"], "C");
        const strike = Number(input.params?.["strike"]);
        return [
          {
            conid: strike,
            symbol: "MSTR",
            maturityDate: "20260814",
            right: "C",
            strike,
          },
        ];
      }
      if (input.path === "iserver/marketdata/snapshot") {
        snapshotReads += 1;
        if (snapshotReads === 1) return [];
        return [
          { conid: 210, "84": "4", "86": "4.2", "7308": "0.2" },
          { conid: 215, "84": "2", "86": "2.2", "7308": "0.1" },
        ];
      }
      throw new Error(`Unexpected request: ${input.path}`);
    },
    { onOptionDiscoveryTelemetry: (event) => telemetry.push(event) }
  );

  const chain = await client.getOptionChain("mstr", "2026-08-14", "C");
  assert.deepEqual(
    chain.map(({ right, strike }) => ({ right, strike })),
    [
      { right: "C", strike: 210 },
      { right: "C", strike: 215 },
    ]
  );
  assert.equal(client.calls.filter(({ path }) => path === "iserver/secdef/info").length, 2);
  assert.ok(
    client.calls
      .filter(({ path }) => path === "iserver/marketdata/snapshot")
      .every(({ params }) => params?.["conids"] === "210,215")
  );
  assert.deepEqual(telemetry, [
    {
      event: "OPTION_DISCOVERY_PHASE",
      phase: "SEARCH",
      symbol: "MSTR",
      month: "AUG26",
      right: "C",
      durationMs: 0,
      definitionRequestCount: 0,
      snapshotBatchCount: 0,
    },
    {
      event: "OPTION_DISCOVERY_PHASE",
      phase: "STRIKES",
      symbol: "MSTR",
      month: "AUG26",
      right: "C",
      durationMs: 0,
      definitionRequestCount: 0,
      snapshotBatchCount: 0,
    },
    {
      event: "OPTION_DISCOVERY_PHASE",
      phase: "DEFINITIONS",
      symbol: "MSTR",
      month: "AUG26",
      right: "C",
      durationMs: 0,
      definitionRequestCount: 2,
      snapshotBatchCount: 0,
    },
    {
      event: "OPTION_DISCOVERY_PHASE",
      phase: "SNAPSHOTS",
      symbol: "MSTR",
      month: "AUG26",
      right: "C",
      durationMs: 0,
      definitionRequestCount: 0,
      snapshotBatchCount: 1,
    },
  ]);
});

void test("exact-expiry put-only discovery does not request or quote calls", async () => {
  let snapshotReads = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 272110, symbol: "MSTR", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/strikes") return { call: [215], put: [95] };
    if (input.path === "iserver/secdef/info") {
      assert.equal(input.params?.["right"], "P");
      return [{ conid: 95, symbol: "MSTR", maturityDate: "20260814", right: "P", strike: 95 }];
    }
    if (input.path === "iserver/marketdata/snapshot") {
      snapshotReads += 1;
      assert.equal(input.params?.["conids"], "95");
      return snapshotReads === 1 ? [] : [{ conid: 95, "84": "1", "86": "1.2", "7308": "-0.1" }];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const chain = await client.getOptionChain("MSTR", "2026-08-14", "P");
  assert.deepEqual(
    chain.map(({ right, strike }) => ({ right, strike })),
    [{ right: "P", strike: 95 }]
  );
  assert.equal(client.calls.filter(({ path }) => path === "iserver/secdef/info").length, 1);
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
    chain.map(({ conid, symbol, bid, ask, mid, delta, volume, openInterest }) => ({
      conid,
      symbol,
      bid,
      ask,
      mid,
      delta,
      volume,
      openInterest,
    })),
    [
      {
        conid: 101,
        symbol: "MSTR  260814C00215000",
        bid: 4,
        ask: 4.2,
        mid: 4.1,
        delta: 0.25,
        volume: null,
        openInterest: null,
      },
    ]
  );
});

void test("complete option-chain snapshot preserves sparse contracts and reports diagnostics", async () => {
  let snapshotReads = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [
        {
          conid: 272110,
          symbol: "MSTR",
          sections: [{ secType: "OPT", exchange: "SMART;CBOE" }],
        },
      ];
    }
    if (input.path === "iserver/secdef/strikes") {
      assert.equal(input.params?.["conid"], "272110");
      return { call: [100, 110, 120], put: [90] };
    }
    if (input.path === "iserver/secdef/info") {
      const strike = input.params?.["strike"];
      if (strike === 100) {
        const definition = {
          conid: 101,
          symbol: "MSTR",
          maturityDate: "20260814",
          right: "C",
          strike: 100,
        };
        return [definition, definition];
      }
      if (strike === 110) {
        return [
          { conid: 102, symbol: "MSTR", maturityDate: "20260814", right: "C", strike: 110 },
          { conid: 0, symbol: "MSTR", maturityDate: "20260814", right: "C", strike: 110 },
        ];
      }
      if (strike === 120) {
        return [
          { conid: 103, symbol: "MSTR", maturityDate: "20260814", right: "C", strike: 120 },
          { conid: 104, symbol: "MSTR", maturityDate: "20260821", right: "C", strike: 120 },
        ];
      }
      return [{ conid: 105, symbol: "MSTR", maturityDate: "20260814", right: "P", strike: 90 }];
    }
    if (input.path === "iserver/marketdata/snapshot") {
      snapshotReads += 1;
      if (snapshotReads === 1) return [];
      return [
        {
          conid: 101,
          "84": 0,
          "86": "0.10",
          "7308": 0,
          "7638": 0,
          "7762": 0,
          "6509": "R",
          _updated: 1_786_665_600_000,
        },
        {
          conid: 102,
          "84": "1.00",
          "86": "1.20",
          "7638": 10,
          "7762": 5,
          "6509": "D",
          _updated: 1_786_665_600_000,
        },
        { conid: 103, "86": "2.00", "7308": "0.20", "7638": 0, "7762": 0 },
      ];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const snapshot = await client.getOptionChainSnapshot("mstr", "2026-08-14", "C");

  assert.deepEqual(
    snapshot.quotes.map(({ conid, symbol, right, bid, ask, mid, delta }) => ({
      conid,
      symbol,
      right,
      bid,
      ask,
      mid,
      delta,
    })),
    [
      {
        conid: 101,
        symbol: "MSTR  260814C00100000",
        right: "C",
        bid: 0,
        ask: 0.1,
        mid: 0.05,
        delta: 0,
      },
      {
        conid: 102,
        symbol: "MSTR  260814C00110000",
        right: "C",
        bid: 1,
        ask: 1.2,
        mid: 1.1,
        delta: null,
      },
      {
        conid: 103,
        symbol: "MSTR  260814C00120000",
        right: "C",
        bid: null,
        ask: 2,
        mid: null,
        delta: 0.2,
      },
    ]
  );
  assert.deepEqual(
    snapshot.quotes.map(({ volume, openInterest, availability, timestamp }) => ({
      volume,
      openInterest,
      availability,
      timestamp,
    })),
    [
      {
        volume: 0,
        openInterest: 0,
        availability: "live",
        timestamp: "2026-08-14T00:00:00.000Z",
      },
      {
        volume: 5,
        openInterest: 10,
        availability: "delayed",
        timestamp: "2026-08-14T00:00:00.000Z",
      },
      { volume: 0, openInterest: 0, availability: null, timestamp: null },
    ]
  );
  assert.deepEqual(snapshot.diagnostics, {
    qualifiedCount: 3,
    returnedCount: 3,
    malformedDefinitionCount: 1,
    missingFieldCounts: {
      bid: 1,
      ask: 0,
      mid: 1,
      delta: 1,
      volume: 0,
      openInterest: 0,
      availability: 1,
      timestamp: 1,
    },
  });
});

void test("complete option-chain snapshot keeps a contract when its snapshot never arrives", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/marketdata/snapshot") return [];
    return discoveryResponse(input);
  });

  const snapshot = await client.getOptionChainSnapshot("MSTR", "2026-08-21", "C");

  assert.deepEqual(snapshot.quotes, [
    {
      conid: 102,
      symbol: "MSTR  260821C00215000",
      underlying: "MSTR",
      expiry: "2026-08-21",
      strike: 215,
      right: "C",
      bid: null,
      ask: null,
      mid: null,
      delta: null,
      volume: null,
      openInterest: null,
      availability: null,
      timestamp: null,
    },
  ]);
  assert.deepEqual(snapshot.diagnostics.missingFieldCounts, {
    bid: 1,
    ask: 1,
    mid: 1,
    delta: 1,
    volume: 1,
    openInterest: 1,
    availability: 1,
    timestamp: 1,
  });
});

void test("complete option-chain snapshot rejects a malformed definition response", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/info") return { unexpected: true };
    return discoveryResponse(input);
  });

  await assert.rejects(
    () => client.getOptionChainSnapshot("MSTR", "2026-08-21", "C"),
    /malformed option definitions/
  );
});

void test("individual option quotes preserve activity values and normalize unavailable data", async () => {
  const cases = [
    {
      name: "positive",
      activity: { "7638": "1,250", "7762": "75" },
      expected: { volume: 75, openInterest: 1250 },
    },
    {
      name: "zero",
      activity: { "7638": 0, "7762": 0 },
      expected: { volume: 0, openInterest: 0 },
    },
    {
      name: "unavailable",
      activity: { "7638": "N/A", "7762": "--", "87": "--" },
      expected: { volume: null, openInterest: null },
    },
    {
      name: "non-finite",
      activity: { "7638": Number.POSITIVE_INFINITY, "7762": "Infinity" },
      expected: { volume: null, openInterest: null },
    },
    {
      name: "unsupported",
      activity: { "7638": "12 contracts", "7762": "75 contracts", "87": "75 contracts" },
      expected: { volume: null, openInterest: null },
    },
  ] as const;

  for (const { name, activity, expected } of cases) {
    let snapshots = 0;
    const client = new FakeIbkrClient((input) => {
      if (input.path !== "iserver/marketdata/snapshot") return discoveryResponse(input);
      snapshots += 1;
      return snapshots === 1
        ? []
        : [{ conid: 102, "84": "4", "86": "4.2", "7308": "0.25", ...activity }];
    });

    const quote = await client.getOptionQuote({
      symbol: "MSTR",
      expiry: "2026-08-21",
      strike: 215,
      right: "C",
    });
    assert.ok(quote, `expected a quote for ${name} activity values`);
    assert.deepEqual({ volume: quote.volume, openInterest: quote.openInterest }, expected, name);
    assert.equal(
      client.calls.find((call) => call.path === "iserver/marketdata/snapshot")?.params?.["fields"],
      "84,86,87,6509,7308,7638,7762"
    );
  }
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

void test("an absent requested option side remains an empty expiry result", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 272110, symbol: "MSTR", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/strikes") return { call: [215], put: [] };
    throw new Error(`Unexpected request: ${input.path}`);
  });

  assert.deepEqual(await client.getOptionExpiries("MSTR", "P", "2026-08-01", "2026-08-31"), []);
  assert.equal(client.calls.filter(({ path }) => path === "iserver/secdef/info").length, 0);
});

void test("a multi-month expiry failure does not start definitions for later months", async () => {
  const definitionMonths: string[] = [];
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/secdef/search") {
        return [{ conid: 272110, symbol: "SPX", sections: [{ secType: "OPT" }] }];
      }
      if (input.path === "iserver/secdef/strikes") return { call: [5_000], put: [] };
      if (input.path === "iserver/secdef/info") {
        const month = String(input.params?.["month"]);
        definitionMonths.push(month);
        if (month === "AUG26") throw new Error("terminal August definition failure");
        return [
          {
            conid: month === "SEP26" ? 102 : 103,
            symbol: "SPX",
            maturityDate: month === "SEP26" ? "20260918" : "20261016",
            right: "C",
            strike: 5_000,
          },
        ];
      }
      throw new Error(`Unexpected request: ${input.path}`);
    },
    { requestScheduler: { maxConcurrent: 1, maxSecdefInfoConcurrent: 1 } }
  );

  await assert.rejects(
    () => client.getOptionExpiries("SPX", "C", "2026-08-01", "2026-10-31"),
    /terminal August definition failure/
  );
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(definitionMonths, ["AUG26"]);
});

void test("terminal definition throttling does not start untouched option strikes", async () => {
  const definitionStrikes: number[] = [];
  const telemetry: string[] = [];
  let schedulerNow = 0;
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/secdef/search") {
        return [{ conid: 272110, symbol: "SPX", sections: [{ secType: "OPT" }] }];
      }
      if (input.path === "iserver/secdef/strikes") {
        return { call: Array.from({ length: 20 }, (_value, index) => 5_000 + index * 5), put: [] };
      }
      if (input.path === "iserver/secdef/info") {
        definitionStrikes.push(Number(input.params?.["strike"]));
        throw rateLimitedError("0");
      }
      throw new Error(`Unexpected request: ${input.path}`);
    },
    {
      requestScheduler: {
        maxConcurrent: 8,
        maxSecdefInfoConcurrent: 8,
        maxRetries: 1,
        retryBaseDelayMs: 1,
        now: () => schedulerNow,
        sleep: async (ms) => {
          schedulerNow += ms;
        },
        retryMaxDelayMs: 1,
        jitterRatio: 0,
      },
      onRequestTelemetry: (event) => {
        if (event.endpoint === "secdef/info" && event.event === "THROTTLED") {
          telemetry.push(event.event);
        }
      },
    }
  );

  await assert.rejects(
    () => client.getOptionExpiries("SPX", "C", "2026-08-01", "2026-08-31"),
    (error: unknown) =>
      error instanceof IbkrRequestSchedulerError && error.code === "IBKR_THROTTLED"
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  const firstChunk = new Set(Array.from({ length: 8 }, (_value, index) => 5_000 + index * 5));
  assert.ok(definitionStrikes.every((strike) => firstChunk.has(strike)));
  assert.ok(definitionStrikes.length <= 8 * 2, "requests stay within one chunk and its retries");
  assert.ok(telemetry.length <= 8 * 2, "telemetry stays within one chunk and its retries");
});

void test("a malformed definition chunk does not start later option strikes", async () => {
  const definitionStrikes: number[] = [];
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/secdef/search") {
        return [{ conid: 272110, symbol: "SPX", sections: [{ secType: "OPT" }] }];
      }
      if (input.path === "iserver/secdef/strikes") {
        return { call: Array.from({ length: 20 }, (_value, index) => 5_000 + index * 5), put: [] };
      }
      if (input.path === "iserver/secdef/info") {
        definitionStrikes.push(Number(input.params?.["strike"]));
        return { unexpected: true };
      }
      throw new Error(`Unexpected request: ${input.path}`);
    },
    { requestScheduler: { maxConcurrent: 8, maxSecdefInfoConcurrent: 8 } }
  );

  await assert.rejects(
    () => client.getOptionExpiries("SPX", "C", "2026-08-01", "2026-08-31"),
    /malformed option definitions/
  );
  assert.deepEqual(
    definitionStrikes,
    Array.from({ length: 8 }, (_value, index) => 5_000 + index * 5)
  );
});

void test("aborting option discovery stops queued definitions and lets a started request settle", async () => {
  const controller = new AbortController();
  let resolveStarted: ((value: unknown) => void) | undefined;
  let startedSettled = false;
  const started = new Promise<unknown>((resolve) => {
    resolveStarted = (value) => {
      startedSettled = true;
      resolve(value);
    };
  });
  let notifyStarted: (() => void) | undefined;
  const firstDefinitionStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/secdef/search") {
        return [{ conid: 272110, symbol: "SPX", sections: [{ secType: "OPT" }] }];
      }
      if (input.path === "iserver/secdef/strikes") {
        return { call: Array.from({ length: 20 }, (_value, index) => 5_000 + index * 5), put: [] };
      }
      if (input.path === "iserver/secdef/info") {
        notifyStarted?.();
        return started;
      }
      throw new Error(`Unexpected request: ${input.path}`);
    },
    { requestScheduler: { maxConcurrent: 1, maxSecdefInfoConcurrent: 1 } }
  );

  const discovery = client.getOptionExpiries("SPX", "C", "2026-08-01", "2026-08-31", {
    signal: controller.signal,
  });
  await firstDefinitionStarted;
  controller.abort();
  await assert.rejects(
    discovery,
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );
  assert.equal(startedSettled, false, "abort does not force the started transport to settle");
  assert.equal(client.calls.filter(({ path }) => path === "iserver/secdef/info").length, 1);

  resolveStarted?.([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(startedSettled, true, "the started transport settles after the caller aborts");
  assert.equal(client.calls.filter(({ path }) => path === "iserver/secdef/info").length, 1);
});

void test("aborting an option chain stops snapshot work after discovery", async () => {
  const controller = new AbortController();
  let resolveSnapshot: ((value: unknown) => void) | undefined;
  let snapshotCalls = 0;
  let notifySnapshotStarted: (() => void) | undefined;
  const snapshotStarted = new Promise<void>((resolve) => {
    notifySnapshotStarted = resolve;
  });
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 272110, symbol: "SPX", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/strikes") return { call: [5_000], put: [] };
    if (input.path === "iserver/secdef/info") {
      return [{ conid: 101, symbol: "SPX", maturityDate: "20260814", right: "C", strike: 5_000 }];
    }
    if (input.path === "iserver/marketdata/snapshot") {
      snapshotCalls += 1;
      if (snapshotCalls === 1) {
        notifySnapshotStarted?.();
        return new Promise((resolve) => {
          resolveSnapshot = resolve;
        });
      }
      return [{ conid: 101, "84": "1.00", "86": "1.20", "7308": "0.50" }];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const chain = client.getOptionChain("SPX", "2026-08-14", "C", {
    signal: controller.signal,
  });
  await snapshotStarted;
  controller.abort();
  resolveSnapshot?.([{ conid: 101, "84": "1.00", "86": "1.20", "7308": "0.50" }]);

  await assert.rejects(
    chain,
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );
  assert.equal(client.calls.filter(({ path }) => path === "iserver/marketdata/snapshot").length, 1);
});

void test("aborting one option discovery does not cancel an independent operation", async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  let resolveFirst: ((value: unknown) => void) | undefined;
  let notifyFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    notifyFirstStarted = resolve;
  });
  const client = new FakeIbkrClient(
    (input) => {
      const symbol = String(input.params?.["symbol"] ?? "");
      if (input.path === "iserver/secdef/search") {
        return [{ conid: symbol === "AAA" ? 101 : 202, symbol, sections: [{ secType: "OPT" }] }];
      }
      if (input.path === "iserver/secdef/strikes") return { call: [100], put: [] };
      if (input.path === "iserver/secdef/info") {
        const conid = String(input.params?.["conid"]);
        if (conid === "101") {
          notifyFirstStarted?.();
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return [{ conid: 20201, symbol: "BBB", maturityDate: "20260814", right: "C", strike: 100 }];
      }
      throw new Error(`Unexpected request: ${input.path}`);
    },
    { requestScheduler: { maxConcurrent: 1, maxSecdefInfoConcurrent: 1 } }
  );

  const first = client.getOptionExpiries("AAA", "C", "2026-08-01", "2026-08-31", {
    signal: firstController.signal,
  });
  const second = client.getOptionExpiries("BBB", "C", "2026-08-01", "2026-08-31", {
    signal: secondController.signal,
  });
  await firstStarted;
  firstController.abort();
  await assert.rejects(
    first,
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );
  resolveFirst?.([]);

  assert.deepEqual(await second, ["2026-08-14"]);
  assert.equal(
    client.calls.filter(
      ({ path, params }) => path === "iserver/secdef/info" && params?.["conid"] === "202"
    ).length,
    1
  );
});

void test("a successful large option discovery returns every qualified definition", async () => {
  const strikes = Array.from({ length: 20 }, (_value, index) => 100 + index * 5);
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 272110, symbol: "SPX", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/strikes") return { call: strikes, put: [] };
    if (input.path === "iserver/secdef/info") {
      const strike = Number(input.params?.["strike"]);
      return [
        { conid: 10_000 + strike, symbol: "SPX", maturityDate: "20260814", right: "C", strike },
      ];
    }
    if (input.path === "iserver/marketdata/snapshot") return [];
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const snapshot = await client.getOptionChainSnapshot("SPX", "2026-08-14", "C");
  assert.deepEqual(
    snapshot.quotes.map(({ strike }) => strike),
    strikes
  );
  assert.equal(
    client.calls.filter(({ path }) => path === "iserver/secdef/info").length,
    strikes.length
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

void test("exhausted 429 retries surface a structured throttling failure", async () => {
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
  assert.ok(caught instanceof IbkrRequestSchedulerError);
  assert.equal(caught.code, "IBKR_THROTTLED");
  assert.equal(caught.endpoint, "secdef/strikes");
  assert.ok(caught.cause instanceof Error);
  assert.equal(caught.cause.message, "Response status 429");
  assert.equal(strikesCalls, 4);
});

void test("temporary broker blocks open a structured circuit without retries", async () => {
  const telemetry: string[] = [];
  let calls = 0;
  const client = new FakeIbkrClient(
    () => {
      calls += 1;
      const error = new Error("IP temporarily blocked after pacing violation") as RateLimitedError;
      error.status = 429;
      throw error;
    },
    {
      onRequestTelemetry: (event) => telemetry.push(`${event.event}:${event.endpoint}`),
    }
  );

  await assert.rejects(
    () => client.getOptionExpiries("MSTR", "C", "2026-08-01", "2026-08-31"),
    (error: unknown) =>
      error instanceof IbkrRequestSchedulerError &&
      error.code === "IBKR_TEMPORARILY_BLOCKED" &&
      error.endpoint === "secdef/search"
  );
  assert.equal(calls, 1);
  assert.deepEqual(telemetry, ["CIRCUIT_OPEN:secdef/search"]);
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

void test("conid details normalize from the secdef array IBKR actually answers with", async () => {
  // Real `trsrv/secdef` payload shape (paper account, 2026-08-06): a `secdef` array, the
  // underlying named `ticker`/`undSym` rather than `symbol`, and a string strike.
  const client = new FakeIbkrClient((input) => {
    assert.equal(input.path, "trsrv/secdef");
    return {
      secdef: [
        {
          conid: 906570511,
          assetClass: "OPT",
          expiry: "20260911",
          lastTradingDay: "20260911",
          putOrCall: "P",
          strike: "281",
          ticker: "IWM",
          undSym: "IWM",
          multiplier: 100,
        },
      ],
    };
  });
  assert.deepEqual(await client.getOptionContract(906570511), {
    conid: 906570511,
    symbol: "IWM   260911P00281000",
    underlying: "IWM",
    expiry: "2026-09-11",
    strike: 281,
    right: "P",
  });
});

void test("conid details ignore a secdef entry that names a different conid", async () => {
  const client = new FakeIbkrClient(() => ({
    secdef: [{ conid: 111, expiry: "20260911", putOrCall: "P", strike: "281", ticker: "IWM" }],
  }));
  assert.equal(await client.getOptionContract(906570511), null);
});

void test("price history validates the contract and returns the exact request context", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [
        {
          conid: 272110,
          symbol: "MSTR",
          sections: [
            { secType: "STK", exchange: "NASDAQ" },
            { secType: "OPT", exchange: "SMART" },
          ],
        },
      ];
    }
    if (input.path === "iserver/contract/272110/info") {
      return {
        con_id: "272110",
        local_symbol: "MSTR",
        instrument_type: "STK",
        exchange: "NASDAQ",
      };
    }
    if (input.path === "iserver/marketdata/history") {
      assert.deepEqual(input.params, {
        conid: "272110",
        exchange: "NASDAQ",
        period: "220d",
        bar: "1d",
        outsideRth: true,
      });
      return {
        volumeFactor: 100,
        data: [
          { t: TEST_NOW - 219 * 86_400_000, o: 90, h: 100, l: 80, c: 95, v: 10 },
          { t: TEST_NOW, o: 100, h: 110, l: 90, c: 105, v: 12 },
        ],
      };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });
  assert.deepEqual(await client.getPriceHistory({ symbol: "MSTR", days: 220 }), {
    bars: [
      {
        datetime: TEST_NOW - 219 * 86_400_000,
        open: 90,
        high: 100,
        low: 80,
        close: 95,
        volume: 1000,
      },
      { datetime: TEST_NOW, open: 100, high: 110, low: 90, close: 105, volume: 1200 },
    ],
    contract: { conid: 272110, symbol: "MSTR", securityType: "STK", exchange: "NASDAQ" },
    request: { requestedSymbol: "MSTR", period: "220d", barSize: "1d" },
  });
});

void test("daily history retries Chart data unavailable and uses a covering standard period", async () => {
  const requestTelemetry: string[] = [];
  let historyCalls = 0;
  const start = TEST_NOW - 219 * 86_400_000;
  const client = new FakeIbkrClient(
    (input) => {
      const contract = historyContractInfo(input);
      if (contract !== undefined) return contract;
      if (input.path !== "iserver/marketdata/history") throw new Error("Unexpected request");
      historyCalls += 1;
      if (historyCalls <= 4) {
        assert.equal(input.params?.["period"], "220d");
        throw httpResponseError(500, { error: "Chart data unavailable" });
      }
      assert.equal(input.params?.["period"], "1y");
      return { data: [bar(start), bar(TEST_NOW)] };
    },
    { onRequestTelemetry: ({ event }) => requestTelemetry.push(event) }
  );

  const result = await client.getPriceHistory({
    symbol: "SPX",
    contract: { conid: 416904 },
    days: 220,
  });
  assert.deepEqual(
    result.bars.map(({ datetime }) => datetime),
    [start, TEST_NOW]
  );
  assert.equal(historyCalls, 5);
  assert.deepEqual(requestTelemetry, [
    "SERVER_RETRY",
    "SERVER_RETRY",
    "SERVER_RETRY",
    "HISTORY_PERIOD_FALLBACK",
  ]);
});

void test("daily history does not recover authentication or entitlement transport errors", async () => {
  for (const [status, body, expectedCalls] of [
    [401, { error: "Authentication required" }, 1],
    [403, { error: "Market data entitlement required" }, 1],
    // A 5xx keeps the bounded scheduler retries, but never the history recovery fallback.
    [500, { error: "Ambiguous contract" }, 4],
  ] as const) {
    let historyCalls = 0;
    const requestTelemetry: string[] = [];
    const client = new FakeIbkrClient(
      (input) => {
        const contract = historyContractInfo(input);
        if (contract !== undefined) return contract;
        historyCalls += 1;
        throw httpResponseError(status, body);
      },
      { onRequestTelemetry: ({ event }) => requestTelemetry.push(event) }
    );
    await assert.rejects(
      () => client.getPriceHistory({ symbol: "SPX", contract: { conid: 416904 }, days: 220 }),
      (error: unknown) => {
        assert.ok(error instanceof IbkrHttpError);
        assert.equal(error.status, status);
        return true;
      }
    );
    assert.equal(historyCalls, expectedCalls);
    assert.deepEqual(
      requestTelemetry.filter((event) => event.startsWith("HISTORY_")),
      []
    );
  }
});

void test("window recovery merges matching overlap bars in chronological order", async () => {
  const start = TEST_NOW - 399 * 86_400_000;
  let historyCalls = 0;
  let previousStart: number | undefined;
  const client = new FakeIbkrClient((input) => {
    const contract = historyContractInfo(input);
    if (contract !== undefined) return contract;
    if (input.path !== "iserver/marketdata/history") throw new Error("Unexpected request");
    historyCalls += 1;
    if (historyCalls <= 4) throw httpResponseError(500, { error: "Chart data unavailable" });
    const window = historyWindow(input);
    const data = [bar(window.start), bar(window.end)];
    if (previousStart !== undefined) data.push(bar(previousStart));
    previousStart = window.start;
    return { data };
  });

  const result = await client.getPriceHistory({
    symbol: "SPX",
    contract: { conid: 416904 },
    startDate: start,
    endDate: TEST_NOW,
  });
  const times = result.bars.map(({ datetime }) => datetime);
  assert.deepEqual(times, [...new Set(times)]);
  assert.deepEqual(
    times,
    [...times].sort((left, right) => left - right)
  );
  assert.equal(times[0], start);
  assert.equal(times.at(-1), TEST_NOW);
});

void test("days history keeps the first calendar-day bar when request time is later", async () => {
  class TimedHistoryClient extends FakeIbkrClient {
    protected override now(): number {
      return TEST_NOW + 18 * 60 * 60 * 1000;
    }
  }
  const first = TEST_NOW - 4 * 86_400_000;
  const client = new TimedHistoryClient((input) => {
    const contract = historyContractInfo(input);
    if (contract !== undefined) return contract;
    if (input.path === "iserver/marketdata/history") {
      return { data: [bar(first), bar(TEST_NOW)] };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const result = await client.getPriceHistory({
    symbol: "SPX",
    contract: { conid: 416904 },
    days: 5,
  });
  assert.deepEqual(
    result.bars.map(({ datetime }) => datetime),
    [first, TEST_NOW]
  );
});

void test("history coverage accepts closed and non-Monday-to-Friday boundary dates", async () => {
  const start = Date.UTC(2026, 11, 25);
  const end = Date.UTC(2027, 0, 24);
  const firstAvailableSession = start + 2 * 86_400_000;
  const lastAvailableSession = end - 2 * 86_400_000;
  const client = new FakeIbkrClient((input) => {
    const contract = historyContractInfo(input);
    if (contract !== undefined) return contract;
    if (input.path === "iserver/marketdata/history") {
      return { data: [bar(firstAvailableSession), bar(lastAvailableSession)] };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const result = await client.getPriceHistory({
    symbol: "SPX",
    contract: { conid: 416904 },
    startDate: start,
    endDate: end,
  });
  assert.deepEqual(
    result.bars.map(({ datetime }) => datetime),
    [firstAvailableSession, lastAvailableSession]
  );
});

void test("window recovery rejects a successful truncated middle window", async () => {
  const start = TEST_NOW - 399 * 86_400_000;
  let historyCalls = 0;
  let windowCalls = 0;
  const client = new FakeIbkrClient((input) => {
    const contract = historyContractInfo(input);
    if (contract !== undefined) return contract;
    if (input.path !== "iserver/marketdata/history") throw new Error("Unexpected request");
    historyCalls += 1;
    if (historyCalls <= 4) throw httpResponseError(500, { error: "Chart data unavailable" });
    windowCalls += 1;
    const window = historyWindow(input);
    if (windowCalls === 2) {
      return { data: [bar(window.start + (window.end - window.start) / 2)] };
    }
    return { data: [bar(window.start), bar(window.end)] };
  });

  await assert.rejects(
    () =>
      client.getPriceHistory({
        symbol: "SPX",
        contract: { conid: 416904 },
        startDate: start,
        endDate: TEST_NOW,
      }),
    (error: unknown) => error instanceof IbkrInsufficientHistoryError
  );
  assert.equal(windowCalls, 2);
});

void test("a later failed window retains completed-window boundary evidence", async () => {
  const start = TEST_NOW - 399 * 86_400_000;
  let historyCalls = 0;
  let firstWindow: { start: number; end: number } | undefined;
  const client = new FakeIbkrClient((input) => {
    const contract = historyContractInfo(input);
    if (contract !== undefined) return contract;
    if (input.path !== "iserver/marketdata/history") throw new Error("Unexpected request");
    historyCalls += 1;
    if (historyCalls <= 4) throw httpResponseError(500, { error: "Chart data unavailable" });
    const window = historyWindow(input);
    if (firstWindow === undefined) {
      firstWindow = window;
      return { data: [bar(window.start), bar(window.end)] };
    }
    throw httpResponseError(500, { error: "Chart data unavailable" });
  });

  await assert.rejects(
    () =>
      client.getPriceHistory({
        symbol: "SPX",
        contract: { conid: 416904 },
        startDate: start,
        endDate: TEST_NOW,
      }),
    (error: unknown) => {
      assert.ok(error instanceof IbkrInsufficientHistoryError);
      assert.notEqual(firstWindow, undefined);
      assert.equal(error.availableStart, firstWindow?.start);
      assert.equal(error.availableEnd, firstWindow?.end);
      return true;
    }
  );
});

void test("overlapping recovery windows reject conflicting normalized duplicate bars", async () => {
  const start = TEST_NOW - 399 * 86_400_000;
  let historyCalls = 0;
  let windowCalls = 0;
  let duplicateTime: number | undefined;
  const client = new FakeIbkrClient((input) => {
    const contract = historyContractInfo(input);
    if (contract !== undefined) return contract;
    if (input.path !== "iserver/marketdata/history") throw new Error("Unexpected request");
    historyCalls += 1;
    if (historyCalls <= 4) throw httpResponseError(500, { error: "Chart data unavailable" });
    windowCalls += 1;
    const window = historyWindow(input);
    const data = [bar(window.start), bar(window.end)];
    if (windowCalls === 1) {
      duplicateTime = window.start + 3 * 86_400_000;
      data.push(bar(duplicateTime));
      return { volumeFactor: 1, data };
    }
    if (windowCalls === 2 && duplicateTime !== undefined) {
      data.push(bar(duplicateTime));
      return { volumeFactor: 2, data };
    }
    return { volumeFactor: 1, data };
  });

  await assert.rejects(
    () =>
      client.getPriceHistory({
        symbol: "SPX",
        contract: { conid: 416904 },
        startDate: start,
        endDate: TEST_NOW,
      }),
    /conflicting history bars/
  );
});

void test("SPX history ignores unrelated security types and sends CBOE index context", async () => {
  const telemetry: unknown[] = [];
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/secdef/search") {
        return [
          { conid: 999, symbol: "SPX", sections: [{ secType: "FUT", exchange: "CME" }] },
          { conid: 998, symbol: "SPXW", sections: [{ secType: "IND", exchange: "CBOE" }] },
          {
            conid: 416904,
            symbol: "SPX",
            sections: [
              { secType: "IND", exchange: "CBOE" },
              { secType: "OPT", exchange: "SMART" },
            ],
          },
          { conid: 997, symbol: "SPX", sections: [{ secType: "OPT", exchange: "CBOE" }] },
        ];
      }
      if (input.path === "iserver/contract/416904/info") {
        return {
          con_id: 416904,
          local_symbol: "SPX",
          instrument_type: "IND",
          exchange: "CBOE",
        };
      }
      if (input.path === "iserver/marketdata/history") {
        assert.equal(input.params?.["conid"], "416904");
        assert.equal(input.params?.["exchange"], "CBOE");
        return completeDailyHistory(220);
      }
      throw new Error(`Unexpected request: ${input.path}`);
    },
    { onPriceHistoryTelemetry: (event) => telemetry.push(event) }
  );

  const result = await client.getPriceHistory({ symbol: "spx", days: 220 });
  assert.deepEqual(result.contract, {
    conid: 416904,
    symbol: "SPX",
    securityType: "IND",
    exchange: "CBOE",
  });
  assert.deepEqual(telemetry, [
    {
      event: "PRICE_HISTORY_REQUEST",
      requestedSymbol: "SPX",
      resolvedConid: 416904,
      securityType: "IND",
      exchange: "CBOE",
      period: "220d",
      barSize: "1d",
    },
  ]);
  assert.equal(JSON.stringify(telemetry).includes("account"), false);
  assert.equal(JSON.stringify(telemetry).includes("http"), false);
  assert.equal(JSON.stringify(telemetry).includes("token"), false);
});

void test("plain-symbol history selects the unique SMART option underlying", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [
        {
          conid: 416904,
          symbol: "SPX",
          sections: [
            { secType: "IND", exchange: "CBOE" },
            { secType: "OPT", exchange: "CBOE;SMART" },
          ],
        },
        {
          conid: 123456,
          symbol: "SPX",
          sections: [
            { secType: "IND", exchange: "NYSE" },
            { secType: "OPT", exchange: "NYSE" },
          ],
        },
      ];
    }
    if (input.path === "iserver/contract/416904/info") {
      return {
        con_id: 416904,
        local_symbol: "SPX",
        instrument_type: "IND",
        exchange: "CBOE",
      };
    }
    if (input.path === "iserver/marketdata/history") return completeDailyHistory(5);
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const result = await client.getPriceHistory({ symbol: "SPX", days: 5 });

  assert.deepEqual(result.contract, {
    conid: 416904,
    symbol: "SPX",
    securityType: "IND",
    exchange: "CBOE",
  });
  assert.equal(client.calls.filter(({ path }) => path === "iserver/secdef/search").length, 1);
});

void test("stock history selects the unique SMART option underlying", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [
        { conid: 200, symbol: "GLD", sections: [{ secType: "STK", exchange: "ARCA" }] },
        {
          conid: 200,
          symbol: "GLD",
          sections: [{ secType: "OPT", exchange: "SMART;BOX" }],
        },
        { conid: 300, symbol: "GLD", sections: [{ secType: "STK", exchange: "MEXI" }] },
        { conid: 300, symbol: "GLD", sections: [{ secType: "OPT", exchange: "MEXI" }] },
      ];
    }
    if (input.path === "iserver/contract/200/info") {
      return {
        con_id: 200,
        local_symbol: "GLD",
        instrument_type: "STK",
        exchange: "ARCA",
      };
    }
    if (input.path === "iserver/marketdata/history") return completeDailyHistory(5);
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const result = await client.getPriceHistory({ symbol: "GLD", days: 5 });

  assert.deepEqual(result.contract, {
    conid: 200,
    symbol: "GLD",
    securityType: "STK",
    exchange: "ARCA",
  });
});

void test("symbol-only history caches validated contract identity for the client session", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [
        {
          conid: 416904,
          symbol: "SPX",
          sections: [
            { secType: "IND", exchange: "CBOE" },
            { secType: "OPT", exchange: "SMART" },
          ],
        },
      ];
    }
    if (input.path === "iserver/contract/416904/info") {
      return {
        con_id: 416904,
        local_symbol: "SPX",
        instrument_type: "IND",
        exchange: "CBOE",
      };
    }
    if (input.path === "iserver/marketdata/history") return completeDailyHistory(5);
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await Promise.all([
    client.getPriceHistory({ symbol: "SPX", days: 5 }),
    client.getPriceHistory({ symbol: "SPX", days: 5 }),
  ]);
  await client.getPriceHistory({ symbol: "spx", days: 5 });

  assert.equal(client.calls.filter(({ path }) => path === "iserver/secdef/search").length, 1);
  assert.equal(
    client.calls.filter(({ path }) => path === "iserver/contract/416904/info").length,
    1
  );
});

void test("failed symbol-only history resolution is not cached", async () => {
  let searchAttempts = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      searchAttempts++;
      return searchAttempts === 1
        ? [{ conid: 200, symbol: "GLD", sections: [{ secType: "STK", exchange: "ARCA" }] }]
        : [
            {
              conid: 200,
              symbol: "GLD",
              sections: [
                { secType: "STK", exchange: "ARCA" },
                { secType: "OPT", exchange: "SMART" },
              ],
            },
          ];
    }
    if (input.path === "iserver/contract/200/info") {
      return {
        con_id: 200,
        local_symbol: "GLD",
        instrument_type: "STK",
        exchange: "ARCA",
      };
    }
    if (input.path === "iserver/marketdata/history") return completeDailyHistory(5);
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await assert.rejects(
    () => client.getPriceHistory({ symbol: "GLD", days: 5 }),
    IbkrPriceHistoryContractError
  );
  const result = await client.getPriceHistory({ symbol: "GLD", days: 5 });

  assert.equal(result.contract.conid, 200);
  assert.equal(searchAttempts, 2);
});

void test("symbol-only history refuses a sole contract without SMART option evidence", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 200, symbol: "GLD", sections: [{ secType: "STK", exchange: "ARCA" }] }];
    }
    throw new Error(`Missing SMART evidence must stop before request: ${input.path}`);
  });

  await assert.rejects(
    () => client.getPriceHistory({ symbol: "GLD", days: 5 }),
    (error: unknown) =>
      error instanceof IbkrPriceHistoryContractError &&
      error.code === "CONTRACT_NOT_FOUND" &&
      error.candidates.length === 1
  );
  assert.deepEqual(
    client.calls.map(({ path }) => path),
    ["iserver/secdef/search"]
  );
});

void test("plain-symbol history refuses ambiguous exact contracts before metadata or history", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [
        {
          conid: 416904,
          symbol: "SPX",
          sections: [
            { secType: "IND", exchange: "CBOE" },
            { secType: "OPT", exchange: "CBOE;SMART" },
          ],
        },
        {
          conid: 123456,
          symbol: "SPX",
          sections: [
            { secType: "IND", exchange: "NYSE" },
            { secType: "OPT", exchange: "SMART;NYSE" },
          ],
        },
      ];
    }
    throw new Error(`Ambiguous resolution must stop before request: ${input.path}`);
  });

  await assert.rejects(
    () => client.getPriceHistory({ symbol: "SPX", days: 220 }),
    (error: unknown) =>
      error instanceof IbkrPriceHistoryContractError &&
      error.code === "CONTRACT_AMBIGUOUS" &&
      error.candidates.length === 2
  );
  assert.deepEqual(
    client.calls.map(({ path }) => path),
    ["iserver/secdef/search"]
  );
});

void test("an explicit history conid bypasses symbol search and validates optional identity", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/contract/416904/info") {
      return {
        con_id: "416904",
        local_symbol: "SPX",
        instrument_type: "IND",
        exchange: "CBOE",
      };
    }
    if (input.path === "iserver/marketdata/history") return completeDailyHistory(5);
    throw new Error(`Explicit resolution must not search: ${input.path}`);
  });

  await client.getPriceHistory({
    symbol: "SPX",
    contract: { conid: 416904, assetClass: "IND", exchange: "cboe" },
    days: 5,
  });
  assert.equal(
    client.calls.some(({ path }) => path === "iserver/secdef/search"),
    false
  );
});

void test("explicit history identity mismatch is distinct and fails before history", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/contract/416904/info") {
      return {
        con_id: "416904",
        local_symbol: "SPX",
        instrument_type: "IND",
        exchange: "CBOE",
      };
    }
    throw new Error(`Mismatched identity must stop before history: ${input.path}`);
  });

  await assert.rejects(
    () =>
      client.getPriceHistory({
        symbol: "SPX",
        contract: { conid: 416904, assetClass: "STK", exchange: "CBOE" },
        days: 5,
      }),
    (error: unknown) =>
      error instanceof IbkrPriceHistoryContractError && error.code === "CONTRACT_MISMATCH"
  );
});

void test("history keeps entitlement and invalid-contract broker rejections distinct", async () => {
  for (const brokerError of [
    { error: "No market data permissions for CBOE IND", code: 1019 },
    { error: "Invalid contract identifier", code: 321 },
  ]) {
    const client = new FakeIbkrClient((input) => {
      if (input.path === "iserver/contract/416904/info") {
        return {
          con_id: "416904",
          local_symbol: "SPX",
          instrument_type: "IND",
          exchange: "CBOE",
        };
      }
      if (input.path === "iserver/marketdata/history") return brokerError;
      throw new Error(`Unexpected request: ${input.path}`);
    });
    await assert.rejects(
      () =>
        client.getPriceHistory({
          symbol: "SPX",
          contract: { conid: 416904 },
          days: 220,
        }),
      (error: unknown) =>
        error instanceof IbkrBrokerResponseError &&
        error.detail.message === brokerError.error &&
        error.detail.code === String(brokerError.code) &&
        error.detail.details === brokerError
    );
  }
});

void test("an invalid explicit conid preserves the contract-info broker rejection", async () => {
  const brokerError = { error: "Invalid contract identifier", code: 321 };
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/contract/999999/info") return brokerError;
    throw new Error(`Invalid contract must stop before history: ${input.path}`);
  });
  await assert.rejects(
    () =>
      client.getPriceHistory({
        symbol: "SPX",
        contract: { conid: 999999 },
        days: 5,
      }),
    (error: unknown) =>
      error instanceof IbkrBrokerResponseError &&
      error.detail.message === brokerError.error &&
      error.detail.code === String(brokerError.code) &&
      error.detail.details === brokerError
  );
});

void test("history search cannot interleave with derivative search-to-strikes priming", async () => {
  let releaseDerivativeSearch: (() => void) | undefined;
  const derivativeSearchCanFinish = new Promise<void>((resolve) => {
    releaseDerivativeSearch = resolve;
  });
  let markDerivativeSearchStarted: (() => void) | undefined;
  const derivativeSearchStarted = new Promise<void>((resolve) => {
    markDerivativeSearchStarted = resolve;
  });
  let primedSymbol: string | undefined;
  const client = new FakeIbkrClient(async (input) => {
    if (input.path === "iserver/secdef/search") {
      const symbol = String(input.params?.["symbol"]);
      if (symbol === "NDX") {
        markDerivativeSearchStarted?.();
        await derivativeSearchCanFinish;
        primedSymbol = symbol;
        return [{ conid: 416843, symbol, sections: [{ secType: "OPT", exchange: "SMART" }] }];
      }
      assert.equal(symbol, "SPX");
      primedSymbol = symbol;
      return [
        {
          conid: 416904,
          symbol,
          sections: [
            { secType: "IND", exchange: "CBOE" },
            { secType: "OPT", exchange: "SMART" },
          ],
        },
      ];
    }
    if (input.path === "iserver/secdef/strikes") {
      return primedSymbol === "NDX" ? { call: [20000], put: [] } : { call: [], put: [] };
    }
    if (input.path === "iserver/secdef/info") {
      return [
        {
          conid: 9001,
          symbol: "NDX",
          secType: "OPT",
          maturityDate: "20260821",
          right: "C",
          strike: 20000,
          exchange: "SMART",
          tradingClass: "NDX",
          multiplier: "100",
        },
      ];
    }
    if (input.path === "iserver/contract/416904/info") {
      return {
        con_id: 416904,
        local_symbol: "SPX",
        instrument_type: "IND",
        exchange: "CBOE",
      };
    }
    if (input.path === "iserver/marketdata/history") return completeDailyHistory(5);
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const derivative = client.getDerivativeContracts({
    underlying: "NDX",
    assetClass: "OPT",
    expiration: "2026-08-21",
  });
  await derivativeSearchStarted;
  const history = client.getPriceHistory({ symbol: "SPX", days: 5 });
  releaseDerivativeSearch?.();

  const [contracts, result] = await Promise.all([derivative, history]);
  assert.equal(contracts[0]?.conid, 9001);
  assert.equal(result.contract.conid, 416904);
  assert.deepEqual(
    client.calls
      .filter(({ path }) => path === "iserver/secdef/search" || path === "iserver/secdef/strikes")
      .map(({ path, params }) => `${path}:${String(params?.["symbol"] ?? "")}`),
    ["iserver/secdef/search:NDX", "iserver/secdef/strikes:", "iserver/secdef/search:SPX"]
  );
});

void test("history rejects malformed and non-finite provider data", async () => {
  for (const history of [
    {},
    { data: [{ t: 1, o: 1, h: 1, l: 1, c: Number.NaN, v: 1 }] },
    { volumeFactor: Number.POSITIVE_INFINITY, data: [] },
  ]) {
    const client = new FakeIbkrClient((input) => {
      if (input.path === "iserver/contract/416904/info") {
        return {
          con_id: "416904",
          local_symbol: "SPX",
          instrument_type: "IND",
          exchange: "CBOE",
        };
      }
      if (input.path === "iserver/marketdata/history") return history;
      throw new Error(`Unexpected request: ${input.path}`);
    });
    await assert.rejects(
      () =>
        client.getPriceHistory({
          symbol: "SPX",
          contract: { conid: 416904 },
          days: 5,
        }),
      /malformed|non-finite/
    );
  }
});

void test("history rejects overflow in normalized volume", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/contract/416904/info") {
      return {
        con_id: 416904,
        local_symbol: "SPX",
        instrument_type: "IND",
        exchange: "CBOE",
      };
    }
    if (input.path === "iserver/marketdata/history") {
      return {
        volumeFactor: 2,
        data: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: Number.MAX_VALUE }],
      };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });
  await assert.rejects(
    () =>
      client.getPriceHistory({
        symbol: "SPX",
        contract: { conid: 416904 },
        days: 5,
      }),
    /non-finite normalized history volume/
  );
});

void test("price history retries one structured 500 and emits safe telemetry", async () => {
  let historyCalls = 0;
  const sleeps: number[] = [];
  const telemetry: unknown[] = [];
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/contract/272110/info") {
        return {
          con_id: 272110,
          local_symbol: "MSTR",
          instrument_type: "STK",
          exchange: "NASDAQ",
        };
      }
      if (input.path === "iserver/marketdata/history") {
        historyCalls += 1;
        if (historyCalls === 1) throw new Error("Response status 500: Chart data unavailable");
        return {
          data: [
            { t: TEST_NOW - 4 * 86_400_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
            { t: TEST_NOW, o: 1, h: 2, l: 0.5, c: 1.6, v: 12 },
          ],
        };
      }
      throw new Error(`Unexpected request: ${input.path}`);
    },
    {
      requestScheduler: {
        maxRetries: 2,
        retryBaseDelayMs: 100,
        retryMaxDelayMs: 500,
        jitterRatio: 0.5,
        now: () => 123,
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      onRequestTelemetry: (event) => telemetry.push(event),
    }
  );

  assert.equal(
    (
      await client.getPriceHistory({
        symbol: "MSTR",
        contract: { conid: 272110, assetClass: "STK" },
        days: 5,
      })
    ).bars[0]?.close,
    1.5
  );
  assert.equal(historyCalls, 2);
  assert.deepEqual(sleeps, [100]);
  assert.deepEqual(telemetry, [
    { event: "SERVER_RETRY", endpoint: "iserver/marketdata", attempt: 1, delayMs: 100 },
  ]);
  assert.doesNotMatch(JSON.stringify(telemetry), /MSTR|272110|token|https?:/i);
});

void test("exhausted price-history retries retain final structured HTTP evidence", async () => {
  let historyCalls = 0;
  const sleeps: number[] = [];
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/contract/272110/info") {
        return {
          con_id: 272110,
          local_symbol: "MSTR",
          instrument_type: "STK",
          exchange: "NASDAQ",
        };
      }
      if (input.path === "iserver/marketdata/history") {
        historyCalls += 1;
        throw new Error(`Response status 503: unavailable-${String(historyCalls)}`);
      }
      throw new Error(`Unexpected request: ${input.path}`);
    },
    {
      requestScheduler: {
        maxRetries: 2,
        retryBaseDelayMs: 100,
        retryMaxDelayMs: 150,
        jitterRatio: 1,
        random: () => 1,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    }
  );

  await assert.rejects(
    () =>
      client.getPriceHistory({
        symbol: "MSTR",
        contract: { conid: 272110, assetClass: "STK" },
        days: 5,
      }),
    (error: unknown) => {
      assert.ok(error instanceof IbkrHttpError);
      assert.equal(error.status, 503);
      assert.equal(error.statusCode, 503);
      assert.deepEqual(error.response, {
        status: 503,
        body: "unavailable-3",
        retryAfter: null,
      });
      return true;
    }
  );
  assert.equal(historyCalls, 3);
  assert.deepEqual(sleeps, [150, 150], "backoff plus jitter stays at the configured bound");
});

void test("price history does not retry a structured non-retryable 4xx", async () => {
  let historyCalls = 0;
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/contract/272110/info") {
        return {
          con_id: 272110,
          local_symbol: "MSTR",
          instrument_type: "STK",
          exchange: "NASDAQ",
        };
      }
      historyCalls += 1;
      throw new Error("Response status 404: No history contract");
    },
    { requestScheduler: { sleep: () => Promise.reject(new Error("must not sleep")) } }
  );

  await assert.rejects(
    () =>
      client.getPriceHistory({
        symbol: "MSTR",
        contract: { conid: 272110, assetClass: "STK" },
        days: 5,
      }),
    (error: unknown) =>
      error instanceof IbkrHttpError &&
      error.status === 404 &&
      error.response.body === "No history contract"
  );
  assert.equal(historyCalls, 1);
});

void test("a cancellation 5xx remains single-attempt", async () => {
  let cancellationCalls = 0;
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/accounts") {
        return { accounts: ["DU123"], selectedAccount: "DU123" };
      }
      if (input.method === "DELETE") {
        cancellationCalls += 1;
        throw new Error("Response status 500: Cancellation state unknown");
      }
      throw new Error(`Unexpected request: ${input.path}`);
    },
    {
      requestScheduler: { maxRetries: 3, sleep: () => Promise.reject(new Error("must not sleep")) },
    }
  );

  await assert.rejects(
    () =>
      client.cancelDerivativeOrder({
        accountId: "DU123",
        orderId: "77",
        assetClass: "OPT",
      }),
    (error: unknown) => error instanceof IbkrHttpError && error.status === 500
  );
  assert.equal(cancellationCalls, 1);
});

void test("known option resolution caches exact requests and reprimes each distinct lookup", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 272110, symbol: "MSTR", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/strikes") {
      throw new Error("Exact option resolution must not enumerate strikes");
    }
    if (input.path === "iserver/secdef/info") {
      assert.equal(input.params?.["conid"], "272110");
      assert.equal(input.params?.["sectype"], "OPT");
      assert.equal(input.params?.["month"], "AUG26");
      if (input.params?.["right"] === "P") {
        assert.equal(input.params["strike"], 95);
        return [{ conid: 103, symbol: "MSTR", maturityDate: "20260821", right: "P", strike: 95 }];
      }
      assert.equal(input.params?.["right"], "C");
      assert.equal(input.params?.["strike"], 215);
      return [
        { conid: 101, symbol: "MSTR", maturityDate: "20260814", right: "C", strike: 215 },
        { conid: 102, symbol: "MSTR", maturityDate: "20260821", right: "C", strike: 215 },
      ];
    }
    if (input.path === "iserver/marketdata/snapshot") {
      return [
        { conid: 102, "84": "4", "86": "4.2", "7308": "0.25" },
        { conid: 103, "84": "1", "86": "1.2", "7308": "-0.1" },
      ];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const request = { symbol: "MSTR", expiry: "2026-08-21", strike: 215, right: "C" as const };
  const [first, second] = await Promise.all([
    client.getOptionQuote(request),
    client.getOptionQuote(request),
  ]);
  const third = await client.getOptionQuote({
    symbol: "mstr",
    expiry: "2026-08-21",
    strike: 95,
    right: "P",
  });
  assert.equal(first?.conid, 102);
  assert.equal(second?.conid, 102);
  assert.equal(third?.conid, 103);
  assert.equal(
    client.calls.filter((call) => call.path === "iserver/secdef/search").length,
    2,
    "each distinct direct definition lookup must refresh session priming"
  );
  assert.equal(client.calls.filter((call) => call.path === "iserver/secdef/info").length, 2);
  assert.equal(client.calls.filter((call) => call.path === "iserver/secdef/strikes").length, 0);
});

void test("option discovery selects one SMART listing among exact ticker matches", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [
        {
          conid: 100,
          symbol: "NFLX",
          sections: [{ secType: "OPT", exchange: "CDE" }],
        },
        {
          conid: 200,
          symbol: "NFLX",
          sections: [{ secType: "OPT", exchange: "BOX;SMART;CBOE" }],
        },
      ];
    }
    if (input.path === "iserver/secdef/info") {
      assert.equal(input.params?.["conid"], "200");
      return [{ conid: 201, symbol: "NFLX", maturityDate: "20260828", right: "C", strike: 75 }];
    }
    if (input.path === "iserver/marketdata/snapshot") {
      return [{ conid: 201, "84": "4", "86": "4.2", "7308": "0.25" }];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const quote = await client.getOptionQuote({
    symbol: "NFLX",
    expiry: "2026-08-28",
    strike: 75,
    right: "C",
  });
  assert.equal(quote?.conid, 201);
});

void test("option discovery rejects more than one SMART listing", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [
        { conid: 100, symbol: "NFLX", sections: [{ secType: "OPT", exchange: "SMART" }] },
        {
          conid: 200,
          symbol: "NFLX",
          sections: [{ secType: "OPT", exchange: "CBOE;SMART" }],
        },
      ];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await assert.rejects(
    () =>
      client.getOptionQuote({
        symbol: "NFLX",
        expiry: "2026-08-28",
        strike: 75,
        right: "C",
      }),
    /underlying identity is ambiguous/
  );
  assert.equal(client.calls.filter((call) => call.path === "iserver/secdef/info").length, 0);
});

void test("known option resolution rejects a mismatched direct definition", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 272110, symbol: "MSTR", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/info") {
      return [{ conid: 101, symbol: "MSTR", maturityDate: "20260814", right: "C", strike: 215 }];
    }
    if (input.path === "iserver/secdef/strikes") {
      throw new Error("Exact option resolution must not enumerate strikes");
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  assert.equal(
    await client.getOptionQuote({
      symbol: "MSTR",
      expiry: "2026-08-21",
      strike: 215,
      right: "C",
    }),
    null
  );
  assert.equal(
    client.calls.filter((call) => call.path === "iserver/marketdata/snapshot").length,
    0
  );
  await client.getOptionQuote({
    symbol: "MSTR",
    expiry: "2026-08-21",
    strike: 215,
    right: "C",
  });
  assert.equal(
    client.calls.filter((call) => call.path === "iserver/secdef/info").length,
    2,
    "a negative response is not cached"
  );
});

void test("known option resolution rejects ambiguous or invalid broker definitions", async () => {
  for (const definitions of [
    [
      { conid: 101, symbol: "MSTR", maturityDate: "20260821", right: "C", strike: 215 },
      { conid: 102, symbol: "MSTR", maturityDate: "20260821", right: "C", strike: 215 },
    ],
    [{ conid: 0, symbol: "MSTR", maturityDate: "20260821", right: "C", strike: 215 }],
  ]) {
    const client = new FakeIbkrClient((input) => {
      if (input.path === "iserver/secdef/search") {
        return [{ conid: 272110, symbol: "MSTR", sections: [{ secType: "OPT" }] }];
      }
      if (input.path === "iserver/secdef/info") return definitions;
      throw new Error(`Unexpected request: ${input.path}`);
    });
    await assert.rejects(
      () =>
        client.getOptionQuote({
          symbol: "MSTR",
          expiry: "2026-08-21",
          strike: 215,
          right: "C",
        }),
      /ambiguous|malformed/
    );
    assert.equal(
      client.calls.filter((call) => call.path === "iserver/marketdata/snapshot").length,
      0
    );
  }
});

void test("known option resolution requires exact broker evidence for the underlying", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 272110, symbol: "WRONG", sections: [{ secType: "OPT" }] }];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });
  await assert.rejects(
    () =>
      client.getOptionQuote({
        symbol: "MSTR",
        expiry: "2026-08-21",
        strike: 215,
        right: "C",
      }),
    /underlying identity is missing/
  );
  assert.equal(client.calls.filter((call) => call.path === "iserver/secdef/info").length, 0);
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
  const quotes = await client.getQuotes([{ symbol }]);
  assert.equal(quotes[symbol]?.quote.lastPrice, 4.1);
  assert.equal(
    client.calls.some(
      (call) => call.path === "iserver/marketdata/snapshot" && call.params?.["conids"] === "102"
    ),
    true
  );
});

void test("getQuotes uses price history by default", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/marketdata/snapshot") {
      snapshots += 1;
      return snapshots === 1 ? [] : [{ conid: 123, "31": "C100.50", "84": "100", "86": "101" }];
    }
    if (input.path === "iserver/marketdata/history") {
      assert.equal(input.params?.["conid"], "123");
      return {
        text: "History description",
        data: [
          { t: 1, o: 98, h: 101, l: 97, c: 99, v: 400 },
          { t: 2, o: 104, h: 106, l: 103, c: 105, v: 500 },
        ],
      };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const quotes = await client.getQuotes([{ symbol: "TEST", brokerId: "123" }]);

  assert.deepEqual(quotes["TEST"], {
    symbol: "TEST",
    availability: "unavailable",
    timestamp: null,
    reference: { description: "History description" },
    quote: {
      lastPrice: 105,
      bidPrice: 100,
      askPrice: 101,
      closePrice: 99,
      highPrice: 106,
      lowPrice: 103,
      openPrice: 104,
      netChange: 6,
      netPercentChange: (6 / 99) * 100,
      totalVolume: 500,
    },
  });
});

void test("getQuotes can return snapshots without price-history requests", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path !== "iserver/marketdata/snapshot") {
      throw new Error(`Snapshot-only quotes must not request ${input.path}`);
    }
    snapshots += 1;
    return snapshots === 1
      ? []
      : [
          {
            conid: 123,
            "31": "C100.50",
            "55": "TEST",
            "70": "102",
            "71": "98",
            "82": "+1.5",
            "83": "+1.51%",
            "84": "100",
            "86": "101",
            "7762": "700",
            "6509": "DpB",
            _updated: 1787000000000,
          },
        ];
  });

  const quotes = await client.getQuotes([{ symbol: "TEST", brokerId: "123" }], {
    includeHistory: false,
  });

  assert.equal(snapshots, 2, "snapshot warm-up and data reads stay enabled");
  assert.deepEqual(quotes["TEST"], {
    symbol: "TEST",
    availability: "delayed",
    timestamp: "2026-08-17T20:53:20.000Z",
    reference: {},
    quote: {
      lastPrice: 100.5,
      bidPrice: 100,
      askPrice: 101,
      highPrice: 102,
      lowPrice: 98,
      netChange: 1.5,
      netPercentChange: 1.51,
      totalVolume: 700,
    },
  });
  assert.equal(quotes["TEST"]?.quote.closePrice, undefined);
  assert.equal(quotes["TEST"]?.quote.openPrice, undefined);
  assert.equal(
    client.calls.some((call) => call.path === "iserver/marketdata/history"),
    false
  );
});

void test("known broker ids quote held options without symbol rediscovery", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/marketdata/snapshot") {
      snapshots += 1;
      assert.equal(input.params?.["conids"], "987654");
      return snapshots === 1
        ? []
        : [{ conid: 987654, "31": "4.10", "55": "NFLX", "84": "4", "86": "4.2" }];
    }
    if (input.path === "iserver/marketdata/history") {
      assert.equal(input.params?.["conid"], "987654");
      return { data: [] };
    }
    throw new Error(`Known broker ids must not use symbol discovery: ${input.path}`);
  });
  const symbol = "NFLX  260821C01200000";
  const quotes = await client.getQuotes([{ symbol, brokerId: "987654" }]);
  assert.equal(quotes[symbol]?.quote.lastPrice, 4.1);
  assert.equal(quotes["NFLX"], undefined);
});

void test("invalid or conflicting broker ids fail before market-data requests", async () => {
  const client = new FakeIbkrClient((input) => {
    throw new Error(`No request was expected: ${input.path}`);
  });
  for (const brokerId of ["", " 1", "0", "-1", "1.5", "12x", "9007199254740992"]) {
    await assert.rejects(
      () => client.getQuotes([{ symbol: "NFLX  260821C01200000", brokerId }]),
      /Invalid IBKR broker contract id/
    );
  }
  await assert.rejects(
    () =>
      client.getQuotes([
        { symbol: "NFLX  260821C01200000", brokerId: "1" },
        { symbol: "NFLX  260821C01200000", brokerId: "2" },
      ]),
    /Conflicting IBKR broker contract ids/
  );
  assert.equal(client.calls.length, 0);
});

void test("index symbol getQuotes falls back to secdef/search when trsrv/stocks is empty", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "trsrv/stocks") return {};
    if (input.path === "iserver/secdef/search") {
      assert.equal(input.params?.["symbol"], "VIX");
      return [
        {
          conid: "13455763",
          symbol: "VIX",
          sections: [
            { secType: "IND", exchange: "CBOE;" },
            { secType: "FUT", exchange: "CFE" },
          ],
        },
      ];
    }
    if (input.path === "iserver/marketdata/snapshot") {
      snapshots += 1;
      return snapshots === 1
        ? []
        : [{ conid: 13455763, "31": "13.50", "84": "13.40", "86": "13.60" }];
    }
    if (input.path === "iserver/marketdata/history") return { data: [] };
    throw new Error(`Unexpected request: ${input.path}`);
  });
  const quotes = await client.getQuotes([{ symbol: "VIX" }]);
  assert.equal(quotes["VIX"]?.quote.lastPrice, 13.5);
  assert.equal(
    client.calls.some(
      (call) =>
        call.path === "iserver/marketdata/snapshot" && call.params?.["conids"] === "13455763"
    ),
    true
  );
});

void test("unresolvable non-stock symbol fails closed without a snapshot", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "trsrv/stocks") return {};
    if (input.path === "iserver/secdef/search") return [{ conid: "9", symbol: "NOPE" }];
    if (input.path === "iserver/marketdata/snapshot") {
      snapshots += 1;
      return [];
    }
    if (input.path === "iserver/marketdata/history") return { data: [] };
    throw new Error(`Unexpected request: ${input.path}`);
  });
  const quotes = await client.getQuotes([{ symbol: "NOPE" }]);
  assert.deepEqual(quotes, {});
  assert.equal(snapshots, 0);
});

void test("secdef/search error object rejects quotes with a typed broker error", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "trsrv/stocks") return {};
    if (input.path === "iserver/secdef/search") {
      assert.equal(input.params?.["symbol"], "$VIX");
      return { error: "No security definition found for symbol" };
    }
    if (input.path === "iserver/marketdata/snapshot") {
      snapshots += 1;
      return [];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await assert.rejects(
    () => client.getQuotes([{ symbol: "$VIX" }]),
    (error: unknown) => {
      assert.ok(error instanceof IbkrBrokerResponseError);
      assert.equal(error.message, "No security definition found for symbol");
      assert.equal(error.detail.message, "No security definition found for symbol");
      assert.deepEqual(error.detail.details, {
        error: "No security definition found for symbol",
      });
      assert.notEqual(error instanceof TypeError, true);
      return true;
    }
  );
  assert.equal(snapshots, 0);
});

void test("secdef/search error object rejects price history with a typed broker error", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "trsrv/stocks") return {};
    if (input.path === "iserver/secdef/search") {
      return { error: "Invalid symbol syntax" };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await assert.rejects(
    () => client.getPriceHistory({ symbol: "$VIX", days: 5 }),
    (error: unknown) => {
      assert.ok(error instanceof IbkrBrokerResponseError);
      assert.match(error.message, /Invalid symbol syntax/);
      assert.notEqual(error instanceof TypeError, true);
      return true;
    }
  );
});

void test("secdef/search malformed payload fails closed for quotes", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "trsrv/stocks") return {};
    if (input.path === "iserver/secdef/search") return { unexpected: true };
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await assert.rejects(
    () => client.getQuotes([{ symbol: "VIX" }]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /malformed secdef\/search response/);
      assert.equal(error instanceof IbkrBrokerResponseError, false);
      assert.notEqual(error instanceof TypeError, true);
      return true;
    }
  );
});

void test("secdef/search error object without text still throws a typed broker error", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "trsrv/stocks") return {};
    if (input.path === "iserver/secdef/search") return { error: "" };
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await assert.rejects(
    () => client.getQuotes([{ symbol: "$VIX" }]),
    (error: unknown) => {
      assert.ok(error instanceof IbkrBrokerResponseError);
      assert.equal(error.message, "IBKR rejected the security-definition search");
      assert.deepEqual(error.detail.details, { error: "" });
      assert.notEqual(error instanceof TypeError, true);
      return true;
    }
  );
});

void test("option quotes carry market-data availability and snapshot timestamp", async () => {
  const cases = [
    {
      name: "live snapshot with an update time",
      snapshot: { "6509": "RpB", _updated: 1787000000000 },
      expected: { availability: "live", timestamp: "2026-08-17T20:53:20.000Z" },
    },
    {
      name: "delayed snapshot",
      snapshot: { "6509": "DpB", _updated: 1787000000000 },
      expected: { availability: "delayed", timestamp: "2026-08-17T20:53:20.000Z" },
    },
    {
      name: "frozen snapshot",
      snapshot: { "6509": "ZpB", _updated: 1787000000 },
      expected: { availability: "frozen", timestamp: "2026-08-17T20:53:20.000Z" },
    },
    {
      // An absent 6509 is "unavailable", and an absent update time stays null rather than
      // becoming a fabricated "now".
      name: "no availability marker and no update time",
      snapshot: {},
      expected: { availability: "unavailable", timestamp: null },
    },
  ] as const;

  for (const { name, snapshot, expected } of cases) {
    let snapshots = 0;
    const client = new FakeIbkrClient((input) => {
      if (input.path !== "iserver/marketdata/snapshot") return discoveryResponse(input);
      snapshots += 1;
      return snapshots === 1
        ? []
        : [{ conid: 102, "84": "4", "86": "4.2", "7308": "0.25", ...snapshot }];
    });

    const quote = await client.getOptionQuote({
      symbol: "MSTR",
      expiry: "2026-08-21",
      strike: 215,
      right: "C",
    });
    assert.ok(quote, `expected a quote for ${name}`);
    assert.deepEqual(
      { availability: quote.availability, timestamp: quote.timestamp },
      expected,
      name
    );
  }
});

void test("underlying quotes carry market-data availability and snapshot timestamp", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "trsrv/stocks") {
      return {
        MSTR: [
          {
            name: "MicroStrategy",
            contracts: [{ conid: 272110, exchange: "NASDAQ", isUS: true }],
          },
        ],
      };
    }
    if (input.path === "iserver/marketdata/snapshot") {
      snapshots += 1;
      return snapshots === 1
        ? []
        : [
            {
              conid: 272110,
              "31": "400.10",
              "55": "MSTR",
              "84": "400.00",
              "86": "400.20",
              "6509": "DpB",
              _updated: 1787000000000,
            },
          ];
    }
    return [];
  });

  const quotes = await client.getQuotes([{ symbol: "MSTR" }]);
  assert.equal(quotes["MSTR"]?.availability, "delayed");
  assert.equal(quotes["MSTR"]?.timestamp, "2026-08-17T20:53:20.000Z");
});

void test("safe POST reads remain retryable after a 429", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const client = new FakeIbkrClient(
    (input) => {
      assert.equal(input.path, "iserver/auth/status");
      assert.equal(input.method, "POST");
      calls += 1;
      if (calls === 1) throw rateLimitedError("1");
      return { authenticated: true, competing: false };
    },
    {
      requestScheduler: {
        // The shared backoff wait recomputes the remaining delay from the clock, so an
        // injected clock keeps the observed sleep exact instead of one tick short.
        now: () => TEST_NOW,
        jitterRatio: 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    }
  );

  assert.deepEqual(await client.getAuthStatus(), { authenticated: true, competing: false });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1_000]);
});

void test("HTTP-date Retry-After uses the injected scheduler clock", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const client = new FakeIbkrClient(
    (input) => {
      assert.equal(input.path, "iserver/auth/status");
      calls += 1;
      if (calls === 1) {
        throw rateLimitedError("Thu, 01 Jan 1970 00:00:10 GMT");
      }
      return { authenticated: true, competing: false };
    },
    {
      requestScheduler: {
        now: () => 0,
        jitterRatio: 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    }
  );

  await client.getAuthStatus();
  assert.deepEqual(sleeps, [10_000]);
});

void test("initialization normalizes raw HTTP failures", async () => {
  const rawError = new Error("Response status 503: Session service unavailable");
  const client = new InitFailureIbkrClient(rawError);

  await assert.rejects(client.init(), (error: unknown) => {
    assert.ok(error instanceof IbkrHttpError);
    assert.equal(error.status, 503);
    assert.deepEqual(error.response, {
      status: 503,
      body: "Session service unavailable",
      retryAfter: null,
    });
    assert.equal(error.cause, rawError);
    return true;
  });
});

void test("price-history 5xx honors Retry-After above the local backoff cap", async () => {
  let historyCalls = 0;
  const sleeps: number[] = [];
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/contract/416904/info") {
        return {
          con_id: 416904,
          local_symbol: "SPX",
          instrument_type: "IND",
          exchange: "CBOE",
        };
      }
      if (input.path === "iserver/marketdata/history") {
        historyCalls += 1;
        if (historyCalls === 1) {
          throw Object.assign(new Error("service unavailable"), {
            status: 503,
            response: {
              status: 503,
              headers: { "Retry-After": "30" },
              data: "Chart data unavailable",
            },
          });
        }
        return completeDailyHistory(5);
      }
      throw new Error(`Unexpected request: ${input.path}`);
    },
    {
      requestScheduler: {
        maxRetries: 1,
        retryBaseDelayMs: 100,
        retryMaxDelayMs: 500,
        jitterRatio: 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    }
  );

  await client.getPriceHistory({
    symbol: "SPX",
    contract: { conid: 416904, assetClass: "IND", exchange: "CBOE" },
    days: 5,
  });
  assert.equal(historyCalls, 2);
  assert.deepEqual(sleeps, [30_000]);
});

void test("account-selection mutations remain single-attempt after a 429", async () => {
  let switchCalls = 0;
  let cancellationCalls = 0;
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/accounts") {
        return { accounts: ["DU123", "DU456"], selectedAccount: "DU456" };
      }
      if (input.path === "iserver/account") {
        switchCalls += 1;
        throw rateLimitedError("1");
      }
      if (input.method === "DELETE") {
        cancellationCalls += 1;
        return { msg: "unexpected" };
      }
      throw new Error(`Unexpected request: ${input.path}`);
    },
    {
      requestScheduler: {
        maxRetries: 3,
        sleep: () => Promise.reject(new Error("must not sleep")),
      },
    }
  );

  await assert.rejects(
    () =>
      client.cancelDerivativeOrder({
        accountId: "DU123",
        orderId: "77",
        assetClass: "OPT",
      }),
    (error: unknown) =>
      error instanceof IbkrRequestSchedulerError && error.code === "IBKR_THROTTLED"
  );
  assert.equal(switchCalls, 1);
  assert.equal(cancellationCalls, 0);
});
