import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient, type IbkrClientOptions } from "../src/ibkr/ibkrClient.js";
import type { IbkrOauth1Config } from "../src/ibkr/oauthConfig.js";
import type {
  OptionContract,
  OptionDefinitionCache,
  OptionDefinitionCacheEntry,
  OptionDefinitionCacheKey,
  OptionDiscoveryTelemetry,
} from "../src/types.js";

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
    private readonly responder: (input: RequestInput) => unknown,
    options: IbkrClientOptions = {}
  ) {
    super(config, {
      ...options,
      requestScheduler: { secdefInfoMinStartIntervalMs: 0, ...options.requestScheduler },
    });
  }

  protected override sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    return Promise.resolve(this.responder(input) as T);
  }

  protected override wait(_ms: number): Promise<void> {
    return Promise.resolve();
  }

  protected override now(): number {
    return TEST_NOW;
  }
}

/** A put month with 5 listed strikes, one definition for each. */
function chainResponder(input: RequestInput): unknown {
  if (input.path === "iserver/secdef/search") {
    return [{ conid: 416904, symbol: "SPX", sections: [{ secType: "OPT" }] }];
  }
  if (input.path === "iserver/secdef/strikes") return { call: [], put: [100, 200, 300, 400, 500] };
  if (input.path === "iserver/secdef/info") {
    const strike = Number(input.params?.["strike"]);
    return [{ conid: 1000 + strike, symbol: "SPX", maturityDate: "20260918", right: "P", strike }];
  }
  if (input.path === "iserver/marketdata/snapshot") return [];
  throw new Error(`Unexpected request: ${input.path}`);
}

function definitionRequests(client: FakeIbkrClient): number[] {
  return client.calls
    .filter((call) => call.path === "iserver/secdef/info")
    .map((call) => Number(call.params?.["strike"]));
}

function contract(strike: number): OptionContract {
  return {
    conid: 9000 + strike,
    symbol: `SPX   260918P00${String(strike)}000`,
    underlying: "SPX",
    tradingClass: "SPX",
    expiry: "2026-09-18",
    strike,
    right: "P",
  };
}

void test("a strike range resolves only the strikes inside the band", async () => {
  const phases: OptionDiscoveryTelemetry[] = [];
  const client = new FakeIbkrClient(chainResponder, {
    onOptionDiscoveryTelemetry: (event) => phases.push(event),
  });

  const contracts = await client.getOptionChainSnapshot("SPX", "2026-09-18", "P", {
    strikeRange: { min: 200, max: 400 },
  });

  assert.deepEqual(definitionRequests(client), [200, 300, 400]);
  assert.equal(contracts.diagnostics.qualifiedCount, 3);
  const definitions = phases.find((phase) => phase.phase === "DEFINITIONS");
  assert.equal(definitions?.listedStrikeCount, 5);
  assert.equal(definitions?.selectedStrikeCount, 3);
  assert.equal(definitions?.definitionRequestCount, 3);
  assert.equal(definitions?.cachedDefinitionCount, 0);
});

void test("an open bound selects every strike on the other side", async () => {
  const client = new FakeIbkrClient(chainResponder);
  await client.getOptionChainSnapshot("SPX", "2026-09-18", "P", { strikeRange: { max: 300 } });
  assert.deepEqual(definitionRequests(client), [100, 200, 300]);
});

void test("no strike range keeps the whole listed month", async () => {
  const client = new FakeIbkrClient(chainResponder);
  await client.getOptionChainSnapshot("SPX", "2026-09-18", "P");
  assert.deepEqual(definitionRequests(client), [100, 200, 300, 400, 500]);
});

void test("a range that selects no listed strike fails instead of reporting an empty chain", async () => {
  const client = new FakeIbkrClient(chainResponder);
  await assert.rejects(
    client.getOptionChainSnapshot("SPX", "2026-09-18", "P", {
      strikeRange: { min: 600, max: 700 },
    }),
    /selected none of the 5 listed strikes/
  );
  assert.deepEqual(definitionRequests(client), []);
});

void test("an unusable strike range is refused before any request", async () => {
  const client = new FakeIbkrClient(chainResponder);
  await assert.rejects(
    client.getOptionChainSnapshot("SPX", "2026-09-18", "P", {
      strikeRange: { min: Number.NaN },
    }),
    TypeError
  );
  await assert.rejects(
    client.getOptionChainSnapshot("SPX", "2026-09-18", "P", {
      strikeRange: { min: 400, max: 200 },
    }),
    TypeError
  );
  assert.deepEqual(client.calls, []);
});

void test("a narrowed result never answers a request for another band", async () => {
  const client = new FakeIbkrClient(chainResponder);
  await client.getOptionChainSnapshot("SPX", "2026-09-18", "P", { strikeRange: { max: 200 } });
  assert.deepEqual(definitionRequests(client), [100, 200]);
  await client.getOptionChainSnapshot("SPX", "2026-09-18", "P");
  assert.deepEqual(definitionRequests(client), [100, 200, 100, 200, 300, 400, 500]);
});

void test("one band is discovered once for repeated requests", async () => {
  const client = new FakeIbkrClient(chainResponder);
  await client.getOptionChainSnapshot("SPX", "2026-09-18", "P", { strikeRange: { max: 200 } });
  await client.getOptionChainSnapshot("SPX", "2026-09-18", "P", { strikeRange: { max: 200 } });
  assert.deepEqual(definitionRequests(client), [100, 200]);
});

void test("a cached definition removes its request and still returns the contract", async () => {
  const reads: OptionDefinitionCacheKey[][] = [];
  const writes: OptionDefinitionCacheEntry[][] = [];
  const cache: OptionDefinitionCache = {
    get: (keys) => {
      reads.push([...keys]);
      return Promise.resolve(keys.map((key) => (key.strike === 200 ? [contract(200)] : null)));
    },
    set: (entries) => {
      writes.push([...entries]);
      return Promise.resolve();
    },
  };
  const phases: OptionDiscoveryTelemetry[] = [];
  const client = new FakeIbkrClient(chainResponder, {
    optionDefinitionCache: cache,
    onOptionDiscoveryTelemetry: (event) => phases.push(event),
  });

  const snapshot = await client.getOptionChainSnapshot("SPX", "2026-09-18", "P", {
    strikeRange: { min: 100, max: 300 },
  });

  assert.deepEqual(definitionRequests(client), [100, 300]);
  assert.equal(snapshot.diagnostics.qualifiedCount, 3);
  assert.deepEqual(
    reads[0]?.map((key) => key.strike),
    [100, 200, 300]
  );
  assert.deepEqual(reads[0]?.[0]?.underlyingConid, 416904);
  assert.deepEqual(
    writes[0]?.map((entry) => entry.key.strike),
    [100, 300]
  );
  const definitions = phases.find((phase) => phase.phase === "DEFINITIONS");
  assert.equal(definitions?.cachedDefinitionCount, 1);
  assert.equal(definitions?.definitionRequestCount, 2);
});

void test("an empty cached record is a hit that lists no contract", async () => {
  const cache: OptionDefinitionCache = {
    get: (keys) => Promise.resolve(keys.map((key) => (key.strike === 200 ? [] : null))),
    set: () => Promise.resolve(),
  };
  const client = new FakeIbkrClient(chainResponder, { optionDefinitionCache: cache });
  const snapshot = await client.getOptionChainSnapshot("SPX", "2026-09-18", "P", {
    strikeRange: { min: 100, max: 300 },
  });
  assert.deepEqual(definitionRequests(client), [100, 300]);
  assert.equal(snapshot.diagnostics.qualifiedCount, 2);
});

void test("a failed, misaligned, or malformed cache read falls back to the broker", async () => {
  const rejecting: OptionDefinitionCache = {
    get: () => Promise.reject(new Error("cache down")),
    set: () => Promise.resolve(),
  };
  const rejectingClient = new FakeIbkrClient(chainResponder, {
    optionDefinitionCache: rejecting,
  });
  await rejectingClient.getOptionChainSnapshot("SPX", "2026-09-18", "P", {
    strikeRange: { max: 200 },
  });
  assert.deepEqual(definitionRequests(rejectingClient), [100, 200]);

  const misaligned: OptionDefinitionCache = {
    get: () => Promise.resolve([[contract(100)]]),
    set: () => Promise.resolve(),
  };
  const misalignedClient = new FakeIbkrClient(chainResponder, {
    optionDefinitionCache: misaligned,
  });
  await misalignedClient.getOptionChainSnapshot("SPX", "2026-09-18", "P", {
    strikeRange: { max: 200 },
  });
  assert.deepEqual(definitionRequests(misalignedClient), [100, 200]);

  const malformed = {
    get: (keys: readonly OptionDefinitionCacheKey[]) =>
      Promise.resolve(keys.map(() => [{ conid: "not-a-number", strike: 100, right: "P" }])),
    set: () => Promise.resolve(),
  } as unknown as OptionDefinitionCache;
  const malformedClient = new FakeIbkrClient(chainResponder, {
    optionDefinitionCache: malformed,
  });
  await malformedClient.getOptionChainSnapshot("SPX", "2026-09-18", "P", {
    strikeRange: { max: 200 },
  });
  assert.deepEqual(definitionRequests(malformedClient), [100, 200]);
});

void test("a cached record filed under the wrong strike or right is refused", async () => {
  const cache: OptionDefinitionCache = {
    get: (keys) => Promise.resolve(keys.map(() => [contract(999)])),
    set: () => Promise.resolve(),
  };
  const client = new FakeIbkrClient(chainResponder, { optionDefinitionCache: cache });
  await client.getOptionChainSnapshot("SPX", "2026-09-18", "P", { strikeRange: { max: 200 } });
  assert.deepEqual(definitionRequests(client), [100, 200]);
});

void test("a cache write failure never fails discovery", async () => {
  const cache: OptionDefinitionCache = {
    get: (keys) => Promise.resolve(keys.map(() => null)),
    set: () => Promise.reject(new Error("disk full")),
  };
  const client = new FakeIbkrClient(chainResponder, { optionDefinitionCache: cache });
  const snapshot = await client.getOptionChainSnapshot("SPX", "2026-09-18", "P", {
    strikeRange: { max: 200 },
  });
  assert.equal(snapshot.diagnostics.qualifiedCount, 2);
});

void test("a malformed broker answer is never stored", async () => {
  const writes: OptionDefinitionCacheEntry[][] = [];
  const cache: OptionDefinitionCache = {
    get: (keys) => Promise.resolve(keys.map(() => null)),
    set: (entries) => {
      writes.push([...entries]);
      return Promise.resolve();
    },
  };
  const client = new FakeIbkrClient(
    (input) => {
      if (input.path === "iserver/secdef/info" && Number(input.params?.["strike"]) === 200) {
        return ["not-a-record"];
      }
      return chainResponder(input);
    },
    { optionDefinitionCache: cache }
  );

  await client.getOptionChainSnapshot("SPX", "2026-09-18", "P", { strikeRange: { max: 200 } });
  assert.deepEqual(
    writes[0]?.map((entry) => entry.key.strike),
    [100]
  );
});
