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

void test("searchInstruments exposes normalized stock contracts", async () => {
  const client = new FakeIbkrClient((input) => {
    assert.equal(input.path, "trsrv/stocks");
    return {
      MSTR: [
        {
          name: "MICROSTRATEGY INC",
          assetClass: "STK",
          contracts: [{ conid: 272110, exchange: "NASDAQ" }],
        },
      ],
    };
  });

  assert.deepEqual(await client.searchInstruments("mstr"), [
    {
      brokerId: "272110",
      symbol: "MSTR",
      description: "MICROSTRATEGY INC",
      exchange: "NASDAQ",
      assetType: "EQUITY",
    },
  ]);
  await assert.rejects(() => client.searchInstruments("MSTR", "fundamental"), /supports only/);
});

void test("getAccountBalances exposes typed total and segment margin snapshots", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "portfolio/accounts") return [{ accountId: "U123" }];
    if (input.path === "portfolio/U123/summary") {
      return {
        netliquidation: { amount: 12_000 },
        availablefunds: { amount: 8_000 },
        buyingpower: { amount: 32_000 },
        totalcashvalue: { amount: 4_000 },
        equitywithloanvalue: { amount: 11_500 },
        "equitywithloanvalue-s": { amount: 10_000 },
        regtequity: { amount: 9_500 },
        "regtmargin-s": { amount: 5_000 },
        initmarginreq: { amount: 2_000 },
        "maintmarginreq-s": { amount: 1_500 },
        excessliquidity: { amount: 0 },
        "availablefunds-c": { amount: "bad-value" },
        sma: { amount: Number.POSITIVE_INFINITY },
        fullavailablefunds: { amount: 7_000 },
        lookaheadnextchange: { amount: 1_754_000_000 },
        "leverage-s": { amount: 1.25 },
      };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  assert.deepEqual(await client.getAccountBalances(), {
    netLiquidation: 12_000,
    availableFunds: 8_000,
    buyingPower: 32_000,
    cashBalance: 4_000,
    margin: {
      total: {
        equityWithLoanValue: 11_500,
        regTEquity: 9_500,
        regTMargin: null,
        initialMarginRequirement: 2_000,
        maintenanceMarginRequirement: null,
        availableFunds: 8_000,
        excessLiquidity: 0,
        cushion: null,
        sma: null,
        buyingPower: 32_000,
        fullInitialMarginRequirement: null,
        fullMaintenanceMarginRequirement: null,
        fullAvailableFunds: 7_000,
        fullExcessLiquidity: null,
        lookAheadInitialMarginRequirement: null,
        lookAheadMaintenanceMarginRequirement: null,
        lookAheadAvailableFunds: null,
        lookAheadExcessLiquidity: null,
        lookAheadNextChange: 1_754_000_000,
        leverage: null,
      },
      securities: {
        equityWithLoanValue: 10_000,
        regTEquity: null,
        regTMargin: 5_000,
        initialMarginRequirement: null,
        maintenanceMarginRequirement: 1_500,
        availableFunds: null,
        excessLiquidity: null,
        cushion: null,
        sma: null,
        buyingPower: null,
        fullInitialMarginRequirement: null,
        fullMaintenanceMarginRequirement: null,
        fullAvailableFunds: null,
        fullExcessLiquidity: null,
        lookAheadInitialMarginRequirement: null,
        lookAheadMaintenanceMarginRequirement: null,
        lookAheadAvailableFunds: null,
        lookAheadExcessLiquidity: null,
        lookAheadNextChange: null,
        leverage: 1.25,
      },
      commodities: {
        equityWithLoanValue: null,
        regTEquity: null,
        regTMargin: null,
        initialMarginRequirement: null,
        maintenanceMarginRequirement: null,
        availableFunds: null,
        excessLiquidity: null,
        cushion: null,
        sma: null,
        buyingPower: null,
        fullInitialMarginRequirement: null,
        fullMaintenanceMarginRequirement: null,
        fullAvailableFunds: null,
        fullExcessLiquidity: null,
        lookAheadInitialMarginRequirement: null,
        lookAheadMaintenanceMarginRequirement: null,
        lookAheadAvailableFunds: null,
        lookAheadExcessLiquidity: null,
        lookAheadNextChange: null,
        leverage: null,
      },
    },
  });
  assert.equal(client.calls.filter(({ path }) => path === "portfolio/U123/summary").length, 1);
});

void test("fetchTransactionHistory normalizes and date-filters IBKR transactions", async () => {
  let positionPage = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "portfolio/accounts") return [{ accountId: "U123" }];
    if (input.path.startsWith("portfolio/U123/positions/")) {
      positionPage += 1;
      return positionPage === 1 ? [{ conid: 265598, contractDesc: "AAPL", assetClass: "STK" }] : [];
    }
    if (input.path === "pa/transactions") {
      return {
        transactions: [
          { conid: 265598, rawDate: "20260715", type: "Trade", qty: 2, pr: 210, amt: -420 },
          { conid: 265598, rawDate: "20260601", type: "Trade", qty: 1, pr: 200, amt: -200 },
        ],
      };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const result = await client.fetchTransactionHistory(
    new Date("2026-07-01T00:00:00Z"),
    new Date("2026-07-31T23:59:59Z")
  );

  assert.equal(result[0]?.accountNumber, "U123");
  assert.equal(result[0]?.transactions.length, 1);
  assert.deepEqual(result[0]?.transactions[0]?.transferItems?.[0], {
    instrument: { assetType: "EQUITY", symbol: "AAPL", description: "AAPL" },
    amount: 2,
    cost: 210,
    transferItemType: "TRADE",
  });
});

void test("getPositions exposes canonical OSI symbols for options", async () => {
  let snapshotCalls = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "portfolio/accounts") return [{ accountId: "U123" }];
    if (input.path === "portfolio/U123/positions/0") {
      return [
        {
          conid: 123,
          contractDesc: "STRC   JUL2026 95 P [STRC  260717P00095000 100]",
          assetClass: "OPT",
          position: 1,
        },
      ];
    }
    if (input.path === "portfolio/U123/positions/1") return [];
    if (input.path === "iserver/marketdata/snapshot") {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? [] : [{ conid: 123, "78": 25 }];
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  assert.equal((await client.getPositions())[0]?.symbol, "STRC  260717P00095000");
});

void test("fetchOrders treats every active IBKR status as WORKING", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "portfolio/accounts") return [{ accountId: "U123" }];
    if (input.path === "iserver/accounts") {
      return { accounts: ["U123"], selectedAccount: "U123" };
    }
    if (input.path === "iserver/account/orders") {
      return {
        orders: [
          { account: "U123", orderId: 1, status: "ApiPending" },
          { account: "U123", orderId: 2, status: "PendingSubmit" },
          { account: "U123", orderId: 3, status: "PreSubmitted" },
          { account: "U123", orderId: 4, status: "Submitted" },
          { account: "U123", orderId: 5, status: "PendingCancel" },
          { account: "U123", orderId: 6, status: "Filled" },
          { account: "OTHER", orderId: 7, status: "Submitted" },
        ],
      };
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const result = await client.fetchOrders({
    fromEnteredTime: new Date("2026-01-01T00:00:00Z"),
    toEnteredTime: new Date("2026-12-31T23:59:59Z"),
    status: "WORKING",
  });

  assert.deepEqual(
    result[0]?.orders.map(({ orderId }) => orderId),
    [1, 2, 3, 4, 5]
  );
  assert.deepEqual(client.calls.find(({ path }) => path === "iserver/account/orders")?.params, {});
});
