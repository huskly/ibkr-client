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

void test("a definition with no listing class is not given one", () => {
  const contract = normalizeOptionContract({
    conid: 123,
    symbol: "IWM",
    maturityDate: "20260911",
    right: "P",
    strike: 281,
  });

  assert.equal(contract?.tradingClass, null, "an absent class is reported, never invented");
  assert.equal(
    contract?.symbol,
    "IWM   260911P00281000",
    "the root falls back to the underlying so the contract stays usable"
  );
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

void test("a month that reaches one symbol from two conids is refused, never returned", async () => {
  // Neither definition states a class, so both fall back to the underlying root. That fallback is
  // allowed only while it cannot hide a collision, and this is the collision.
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 416904, symbol: "SPX", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/strikes") return { call: [], put: [7000] };
    if (input.path === "iserver/secdef/info") {
      return [
        {
          conid: 782403981,
          symbol: "SPX",
          secType: "OPT",
          maturityDate: "20260917",
          right: "P",
          strike: 7000,
        },
        {
          conid: 909968540,
          symbol: "SPX",
          secType: "OPT",
          maturityDate: "20260917",
          right: "P",
          strike: 7000,
        },
      ];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await assert.rejects(
    client.getOptionChainSnapshot("SPX", "2026-09-17", "P"),
    /two option contracts with one identity for SPX SEP26: SPX   260917P07000000 is conid 782403981 and 909968540/
  );
});

void test("one stated class beside one unstated class is not a collision", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/marketdata/snapshot") {
      return [
        { conid: 782403981, "84": "9.0", "86": "9.4", "7308": "-0.09" },
        { conid: 909968540, "84": "10.0", "86": "10.4", "7308": "-0.10" },
      ];
    }
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 416904, symbol: "SPX", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/strikes") return { call: [], put: [7000] };
    if (input.path === "iserver/secdef/info") {
      return [
        {
          conid: 782403981,
          symbol: "SPX",
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
  });

  const chain = await client.getOptionChain("SPX", "2026-09-17", "P");

  assert.deepEqual(
    chain.map(({ conid, symbol }) => ({ conid, symbol })).sort((a, b) => a.conid - b.conid),
    [
      { conid: 782403981, symbol: "SPX   260917P07000000" },
      { conid: 909968540, symbol: "SPXW  260917P07000000" },
    ]
  );
});

void test("an OSI quote request carries its root through as the listing class", async () => {
  const searched: string[] = [];
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      searched.push(String(input.params?.["symbol"]));
      return [{ conid: 416904, symbol: "SPXW", sections: [{ secType: "OPT" }] }];
    }
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
    if (input.path === "iserver/marketdata/history") return { data: [] };
    if (input.path === "iserver/marketdata/snapshot") {
      snapshots += 1;
      return snapshots === 1
        ? []
        : [{ conid: 909968540, "31": "10.2", "84": "10.0", "86": "10.4" }];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const quotes = await client.getQuotes([{ symbol: "SPXW  260917P07000000" }]);

  assert.equal(searched[0], "SPXW", "the OSI root is what IBKR is asked for");
  assert.equal(quotes["SPXW  260917P07000000"]?.quote.lastPrice, 10.2);
  assert.equal(
    client.calls.some(
      (call) =>
        call.path === "iserver/marketdata/snapshot" && call.params?.["conids"] === "909968540"
    ),
    true,
    "the weekly conid is quoted, never the monthly one"
  );
});

void test("an OSI quote request for a single-class name is unchanged", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: 9579970, symbol: "IWM", sections: [{ secType: "OPT" }] }];
    }
    if (input.path === "iserver/secdef/info") {
      return [
        {
          conid: 906570511,
          symbol: "IWM",
          secType: "OPT",
          maturityDate: "20260911",
          right: "P",
          strike: 281,
        },
      ];
    }
    if (input.path === "iserver/marketdata/history") return { data: [] };
    if (input.path === "iserver/marketdata/snapshot") {
      snapshots += 1;
      return snapshots === 1 ? [] : [{ conid: 906570511, "31": "1.1", "84": "1.0", "86": "1.2" }];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const quotes = await client.getQuotes([{ symbol: "IWM   260911P00281000" }]);

  assert.equal(quotes["IWM   260911P00281000"]?.quote.lastPrice, 1.1);
});
