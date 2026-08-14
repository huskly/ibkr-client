import test from "node:test";
import assert from "node:assert/strict";
import { IbkrBrokerResponseError, IbkrClient } from "../src/ibkr/ibkrClient.js";
import { normalizeDerivativeDataAvailability } from "../src/ibkr/derivativeContract.js";
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

const nqSearch = [
  {
    conid: "11004958",
    symbol: "NQ",
    sections: [
      { secType: "IND", exchange: "CME;" },
      { secType: "FUT", months: "SEP26;DEC26", exchange: "CME" },
      { secType: "FOP", months: "AUG26;SEP26", exchange: "CME" },
    ],
  },
];

const nqAug26600Definitions = [
  {
    conid: 892767774,
    symbol: "NQ",
    secType: "FOP",
    exchange: "CME",
    right: "P",
    strike: 26600,
    maturityDate: "20260821",
    multiplier: "20",
    tradingClass: "QN3",
  },
  {
    conid: 899757056,
    symbol: "NQ",
    secType: "FOP",
    exchange: "CME",
    right: "P",
    strike: 26600,
    maturityDate: "20260828",
    multiplier: "20",
    tradingClass: "QN4",
  },
];

const ndxAug20Definitions = [
  {
    conid: 851296101,
    symbol: "NDX",
    secType: "OPT",
    exchange: "SMART",
    right: "P",
    strike: 26600,
    maturityDate: "20260820",
    multiplier: "100",
    tradingClass: "NDX",
  },
  {
    conid: 903244292,
    symbol: "NDX",
    secType: "OPT",
    exchange: "SMART",
    right: "P",
    strike: 26600,
    maturityDate: "20260820",
    multiplier: "100",
    tradingClass: "NDXP",
  },
];

void test("NQ Aug 21 puts resolve as exact QN3 FOP identity from real response shapes", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") return nqSearch;
    if (input.path === "iserver/secdef/strikes") {
      return { call: [], put: [26400, 26600, 26800] };
    }
    if (input.path === "iserver/secdef/info") return nqAug26600Definitions;
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const contract = await client.resolveDerivativeContract({
    assetClass: "FOP",
    underlying: "NQ",
    expiration: "2026-08-21",
    strike: 26600,
    right: "P",
    tradingClass: "QN3",
  });

  assert.deepEqual(contract, {
    conid: 892767774,
    assetClass: "FOP",
    underlying: "NQ",
    expiration: "2026-08-21",
    strike: 26600,
    right: "P",
    tradingClass: "QN3",
    exchange: "CME",
    multiplier: 20,
  });
  assert.deepEqual(
    client.calls.map(({ path }) => path),
    ["iserver/secdef/search", "iserver/secdef/strikes", "iserver/secdef/info"]
  );
  assert.equal(client.calls[0]?.params?.["secType"], "FUT");
  assert.equal(client.calls[1]?.params?.["sectype"], "FOP");
  assert.equal(client.calls[1]?.params?.["exchange"], "CME");
  assert.equal(client.calls[2]?.params?.["strike"], 26600);
  assert.equal(client.calls.filter(({ path }) => path === "iserver/secdef/info").length, 1);
  assert.ok(client.calls.every((call) => call.method === undefined || call.method === "GET"));
});

void test("multi-month derivative discovery serializes priming and bounds secdef expansion", async () => {
  let activeInfo = 0;
  let maximumInfo = 0;
  const observed: string[] = [];
  const maturity: Record<string, string> = { AUG26: "20260821", SEP26: "20260918" };
  const client = new FakeIbkrClient((input) => {
    const month = String(input.params?.["month"] ?? "");
    observed.push(`${input.path}:${month}`);
    if (input.path === "iserver/secdef/search") return nqSearch;
    if (input.path === "iserver/secdef/strikes") return { call: [], put: [26600, 26700] };
    if (input.path === "iserver/secdef/info") {
      activeInfo += 1;
      maximumInfo = Math.max(maximumInfo, activeInfo);
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve([
            {
              conid: Number(`${month === "AUG26" ? "8" : "9"}${String(input.params?.["strike"])}`),
              symbol: "NQ",
              secType: "FOP",
              exchange: "CME",
              right: "P",
              strike: Number(input.params?.["strike"]),
              maturityDate: maturity[month],
              multiplier: "20",
              tradingClass: "QN3",
            },
          ]);
        }, 5);
      }).finally(() => {
        activeInfo -= 1;
      });
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const expiries = await client.getDerivativeExpiries({
    assetClass: "FOP",
    underlying: "NQ",
    from: "2026-08-01",
    to: "2026-09-30",
    right: "P",
  });
  assert.deepEqual(
    expiries.map(({ expiration }) => expiration),
    ["2026-08-21", "2026-09-18"]
  );
  assert.equal(maximumInfo, 1);
  const firstSeptember = observed.findIndex((entry) => entry.includes(":SEP26"));
  const lastAugust = observed.findLastIndex((entry) => entry.includes(":AUG26"));
  assert.ok(firstSeptember > lastAugust);
});

void test("NDX and NDXP at the same expiry and strike remain distinct and ambiguous selection fails closed", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [
        {
          conid: "416843",
          symbol: "NDX",
          sections: [{ secType: "OPT", months: "AUG26", exchange: "SMART;CBOE" }],
        },
      ];
    }
    if (input.path === "iserver/secdef/strikes") return { call: [], put: [26600] };
    if (input.path === "iserver/secdef/info") return ndxAug20Definitions;
    throw new Error(`Unexpected request: ${input.path}`);
  });
  const exact = {
    assetClass: "OPT" as const,
    underlying: "NDX",
    expiration: "2026-08-20",
    strike: 26600,
    right: "P" as const,
    exchange: "SMART",
  };

  const contracts = await client.getDerivativeContracts(exact);
  assert.deepEqual(
    contracts.map(({ tradingClass, conid }) => ({ tradingClass, conid })),
    [
      { tradingClass: "NDX", conid: 851296101 },
      { tradingClass: "NDXP", conid: 903244292 },
    ]
  );
  await assert.rejects(() => client.resolveDerivativeContract(exact), /Ambiguous.*NDX, NDXP/);
  const ndxp = await client.resolveDerivativeContract({ ...exact, tradingClass: "NDXP" });
  assert.equal(ndxp.conid, 903244292);
  assert.equal(ndxp.multiplier, 100);
});

void test("derivative chains retain unavailable fields and require at least one usable market", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") return nqSearch;
    if (input.path === "iserver/secdef/strikes") return { call: [], put: [26600] };
    if (input.path === "iserver/secdef/info") return nqAug26600Definitions;
    if (input.path === "iserver/marketdata/snapshot") {
      snapshots += 1;
      return snapshots === 1
        ? []
        : [
            {
              conid: 892767774,
              "31": "383.00",
              "84": "330.50",
              "86": "337.50",
              "6509": "RBd",
              "7308": "-0.257",
              "7635": "331.33",
              "7638": "50",
              "7762": "237",
              _updated: 1785349006176,
            },
          ];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const quotes = await client.getDerivativeChain({
    assetClass: "FOP",
    underlying: "NQ",
    expiration: "2026-08-21",
    tradingClass: "QN3",
    right: "P",
  });
  assert.equal(quotes.length, 1);
  assert.deepEqual(quotes[0], {
    contract: {
      conid: 892767774,
      assetClass: "FOP",
      underlying: "NQ",
      expiration: "2026-08-21",
      strike: 26600,
      right: "P",
      tradingClass: "QN3",
      exchange: "CME",
      multiplier: 20,
    },
    availability: "live",
    timestamp: "2026-07-29T18:16:46.176Z",
    bid: 330.5,
    ask: 337.5,
    last: 383,
    mark: 331.33,
    delta: -0.257,
    impliedVolatility: null,
    volume: 237,
    openInterest: 50,
  });
  assert.ok(client.calls.every((call) => !call.path.includes("/orders")));
});

void test("empty post-prime derivative strikes and all-unusable quotes reject explicitly", async () => {
  const empty = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") return nqSearch;
    if (input.path === "iserver/secdef/strikes") return { call: [], put: [] };
    throw new Error(`Unexpected request: ${input.path}`);
  });
  await assert.rejects(
    () =>
      empty.getDerivativeChain({
        assetClass: "FOP",
        underlying: "NQ",
        expiration: "2026-08-21",
      }),
    /empty FOP strikes.*secdef\/search priming/
  );

  let snapshots = 0;
  const unavailable = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") return nqSearch;
    if (input.path === "iserver/secdef/strikes") return { call: [], put: [26600] };
    if (input.path === "iserver/secdef/info") return nqAug26600Definitions;
    if (input.path === "iserver/marketdata/snapshot") {
      snapshots += 1;
      return snapshots === 1 ? [] : [{ conid: 892767774, "6509": "N" }];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });
  await assert.rejects(
    () =>
      unavailable.getDerivativeChain({
        assetClass: "FOP",
        underlying: "NQ",
        expiration: "2026-08-21",
      }),
    /no usable derivative quotes/
  );
});

void test("IBKR availability codes normalize without inventing live data", () => {
  assert.equal(normalizeDerivativeDataAvailability("RpB"), "live");
  assert.equal(normalizeDerivativeDataAvailability("DpB"), "delayed");
  assert.equal(normalizeDerivativeDataAvailability("ZpB"), "frozen");
  assert.equal(normalizeDerivativeDataAvailability("YpB"), "frozen-delayed");
  assert.equal(normalizeDerivativeDataAvailability("NpB"), "unavailable");
  assert.equal(normalizeDerivativeDataAvailability(undefined), "unavailable");
});

void test("derivative timestamps accept IBKR epoch seconds as well as milliseconds", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") return nqSearch;
    if (input.path === "iserver/secdef/strikes") return { call: [], put: [26600] };
    if (input.path === "iserver/secdef/info") return nqAug26600Definitions;
    if (input.path === "iserver/marketdata/snapshot") {
      snapshots += 1;
      return snapshots === 1
        ? []
        : [{ conid: 892767774, "84": 1, "86": 2, "6509": "D", _updated: 1685600000 }];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const [quote] = await client.getDerivativeChain({
    assetClass: "FOP",
    underlying: "NQ",
    expiration: "2026-08-21",
    tradingClass: "QN3",
  });
  assert.equal(quote?.timestamp, "2023-06-01T06:13:20.000Z");
  assert.equal(quote?.availability, "delayed");
});

void test("FOP reference quotes follow the broker-linked futures conid", async () => {
  let snapshots = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "trsrv/secdef") {
      return {
        secdef: [
          {
            conid: 892767774,
            ticker: "NQ",
            undConid: 770561204,
            undSym: "NQ",
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
              conid: 770561204,
              "31": "27865.50",
              "55": "NQ",
              "84": "27865.00",
              "86": "27866.50",
              "6509": "RB",
              "7635": "27864.25",
              _updated: 1785348475692,
            },
          ];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const reference = await client.getDerivativeReferenceQuote({
    conid: 892767774,
    assetClass: "FOP",
    underlying: "NQ",
    expiration: "2026-08-21",
    strike: 26600,
    right: "P",
    tradingClass: "QN3",
    exchange: "CME",
    multiplier: 20,
  });
  assert.deepEqual(reference, {
    conid: 770561204,
    symbol: "NQ",
    availability: "live",
    timestamp: "2026-07-29T18:07:55.692Z",
    bid: 27865,
    ask: 27866.5,
    last: 27865.5,
    mark: 27864.25,
  });
  assert.equal(client.calls[0]?.params?.["conids"], "892767774");
  assert.ok(client.calls.every((call) => !call.path.includes("/orders")));
});

void test("secdef/search error object rejects derivative discovery with a typed broker error", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return { error: "No security definition found for symbol" };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await assert.rejects(
    () =>
      client.resolveDerivativeContract({
        assetClass: "FOP",
        underlying: "$NQ",
        expiration: "2026-08-21",
        strike: 26600,
        right: "P",
        tradingClass: "QN3",
      }),
    (error: unknown) => {
      assert.ok(error instanceof IbkrBrokerResponseError);
      assert.equal(error.message, "No security definition found for symbol");
      assert.notEqual(error instanceof TypeError, true);
      return true;
    }
  );
  assert.deepEqual(
    client.calls.map(({ path }) => path),
    ["iserver/secdef/search"]
  );
});

void test("secdef/search malformed payload fails closed for derivative discovery", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") return { unexpected: true };
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await assert.rejects(
    () =>
      client.getDerivativeContracts({
        assetClass: "FOP",
        underlying: "NQ",
        expiration: "2026-08-21",
        right: "P",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /malformed secdef\/search response/);
      assert.equal(error instanceof IbkrBrokerResponseError, false);
      assert.notEqual(error instanceof TypeError, true);
      return true;
    }
  );
});

void test("secdef/search error object rejects option underlying discovery with a typed broker error", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return { error: "No security definition found for symbol" };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await assert.rejects(
    () =>
      client.getOptionQuote({
        symbol: "$MSTR",
        expiry: "2026-08-21",
        strike: 215,
        right: "C",
      }),
    (error: unknown) => {
      assert.ok(error instanceof IbkrBrokerResponseError);
      assert.equal(error.message, "No security definition found for symbol");
      assert.notEqual(error instanceof TypeError, true);
      return true;
    }
  );
});

// Real `iserver/secdef/search` shape for `UNH`: IBKR answers with both the NYSE common stock and
// a Canadian Depositary Receipt on Toronto whose options trade on `CDE`. `NFLX` answers the same
// way. Only the US listing routes options on SMART (#671).
const unhSearch = [
  {
    conid: "13272",
    symbol: "UNH",
    companyHeader: "UNITEDHEALTH GROUP INC - NYSE",
    description: "NYSE",
    sections: [
      { secType: "STK" },
      {
        secType: "OPT",
        months: "AUG26;SEP26",
        exchange:
          "SMART;AMEX;BATS;BOX;CBOE;CBOE2;EDGX;EMERALD;GEMINI;IBUSOPT;ISE;MEMX;MERCURY;MIAX;NASDAQBX;NASDAQOM;PEARL;PHLX;PSE;SAPPHIRE",
      },
    ],
  },
  {
    conid: "575959888",
    symbol: "UNH",
    companyHeader: "UNITEDHEALTH GROUP INC - CDR - TSE",
    description: "TSE",
    sections: [{ secType: "STK" }, { secType: "OPT", months: "AUG26;SEP26", exchange: "CDE" }],
  },
];

const unhSep375Definitions = [
  {
    conid: 800000001,
    symbol: "UNH",
    secType: "OPT",
    exchange: "SMART",
    right: "P",
    strike: 375,
    maturityDate: "20260904",
    multiplier: "100",
    tradingClass: "UNH",
  },
];

void test("a ticker that also names a depositary receipt resolves through the SMART listing", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") return unhSearch;
    if (input.path === "iserver/secdef/strikes") return { call: [], put: [365, 375] };
    if (input.path === "iserver/secdef/info") return unhSep375Definitions;
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const contract = await client.resolveDerivativeContract({
    assetClass: "OPT",
    underlying: "UNH",
    expiration: "2026-09-04",
    strike: 375,
    right: "P",
  });

  assert.equal(contract.conid, 800000001);
  // Discovery must ask about the NYSE listing, never the Toronto depositary receipt.
  const strikes = client.calls.find(({ path }) => path === "iserver/secdef/strikes");
  assert.equal(strikes?.params?.["conid"], "13272");
  const info = client.calls.find(({ path }) => path === "iserver/secdef/info");
  assert.equal(info?.params?.["conid"], "13272");
});

void test("two SMART listings stay ambiguous and name the competing listings", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [
        unhSearch[0],
        {
          conid: "999000111",
          symbol: "UNH",
          companyHeader: "UNITEDHEALTH GROUP INC - ARCA",
          sections: [{ secType: "OPT", months: "SEP26", exchange: "SMART;ARCA" }],
        },
      ];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await assert.rejects(
    client.resolveDerivativeContract({
      assetClass: "OPT",
      underlying: "UNH",
      expiration: "2026-09-04",
      strike: 375,
      right: "P",
    }),
    (error: Error) => {
      // Fail closed, and tell the operator exactly which listings competed so a `tradingClass`
      // or an explicit conid can settle it.
      assert.match(error.message, /IBKR OPT underlying identity is ambiguous for UNH/);
      assert.match(error.message, /conid 13272 UNITEDHEALTH GROUP INC - NYSE/);
      assert.match(error.message, /conid 999000111 UNITEDHEALTH GROUP INC - ARCA \(SMART\/ARCA\)/);
      return true;
    }
  );
});

void test("a symbol with no listing of the requested asset class is reported as missing", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [{ conid: "13272", symbol: "UNH", sections: [{ secType: "STK" }] }];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await assert.rejects(
    client.resolveDerivativeContract({
      assetClass: "OPT",
      underlying: "UNH",
      expiration: "2026-09-04",
      strike: 375,
      right: "P",
    }),
    // A missing listing names nothing, because there is no competing listing to report.
    /IBKR OPT underlying identity is missing for UNH$/
  );
});

void test("one listing repeated across sections is one candidate, not an ambiguity", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/secdef/search") {
      return [
        {
          conid: "13272",
          symbol: "UNH",
          sections: [
            { secType: "OPT", months: "AUG26", exchange: "SMART;CBOE" },
            { secType: "OPT", months: "SEP26", exchange: "SMART;PHLX" },
          ],
        },
        // A different ticker is a different instrument and is never a candidate.
        {
          conid: "424242",
          symbol: "UNHX",
          sections: [{ secType: "OPT", months: "SEP26", exchange: "SMART" }],
        },
      ];
    }
    if (input.path === "iserver/secdef/strikes") return { call: [], put: [375] };
    if (input.path === "iserver/secdef/info") return unhSep375Definitions;
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const contract = await client.resolveDerivativeContract({
    assetClass: "OPT",
    underlying: "UNH",
    expiration: "2026-09-04",
    strike: 375,
    right: "P",
  });
  assert.equal(contract.conid, 800000001);
});
