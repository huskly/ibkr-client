import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient } from "../src/ibkr/ibkrClient.js";
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
    super(config);
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

void test("multi-month derivative discovery serializes session priming and secdef expansion", async () => {
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
