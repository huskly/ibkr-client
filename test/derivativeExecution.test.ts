import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient } from "../src/ibkr/ibkrClient.js";
import type { DerivativeComboExecutionRequest, DerivativeContract } from "../src/types.js";
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

function contract(conid: number, strike: number): DerivativeContract {
  return {
    conid,
    assetClass: "FOP",
    underlying: "NQ",
    expiration: "2026-08-21",
    strike,
    right: "P",
    tradingClass: "QN3",
    exchange: "CME",
    multiplier: 20,
  };
}

function executionRequest(): DerivativeComboExecutionRequest {
  return {
    accountId: "U123",
    legs: [
      { contract: contract(892767804, 26400), ratio: 1 },
      { contract: contract(892767774, 26600), ratio: -1 },
    ],
    quantity: 1,
    priceEffect: "CREDIT",
    limit: 39,
    tif: "DAY",
    session: "REGULAR",
    clientOrderId: "huskly-20260729-abc",
    extOperator: "felipecsl",
    manualIndicator: true,
  };
}

function sessionResponse(input: RequestInput): unknown {
  if (input.path === "iserver/auth/status") return { authenticated: true, competing: false };
  if (input.path === "iserver/accounts") {
    return { accounts: ["U123"], selectedAccount: "U123", isPaper: true };
  }
  throw new Error(`Unexpected request ${input.path}`);
}

void test("atomic submission includes exact ratios, signed credit, client ID, and CME metadata", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        {
          id: "reply-known",
          message: ["Price exceeds the configured percentage constraint"],
          messageIds: ["o163"],
        },
      ];
    }
    return sessionResponse(input);
  });

  const result = await client.submitDerivativeCombo(executionRequest());
  assert.equal(result.state, "warning");
  assert.equal(result.state === "warning" && result.warnings[0]?.known, true);
  const placement = client.calls.find(({ path }) => path === "iserver/account/U123/orders");
  assert.deepEqual(placement?.data, {
    orders: [
      {
        acctId: "U123",
        conidex: "28812380@CME;;;892767804/1,892767774/-1",
        orderType: "LMT",
        price: -39,
        side: "BUY",
        tif: "DAY",
        quantity: 1,
        outsideRTH: false,
        cOID: "huskly-20260729-abc",
        extOperator: "felipecsl",
        manualIndicator: true,
      },
    ],
  });
  assert.equal(client.calls.filter(({ path }) => path === "iserver/account/U123/orders").length, 1);
});

void test("warning replies distinguish known chains from unknown warnings", async () => {
  const responses = [
    [{ id: "unknown", message: ["Unclassified broker warning"], messageIds: ["x999"] }],
    [{ id: "known", message: ["Percentage constraint"], messageIds: ["o163"] }],
    [{ order_id: "777", order_status: "PreSubmitted" }],
  ];
  const client = new FakeIbkrClient((input) => {
    if (input.path.startsWith("iserver/reply/")) return responses.shift();
    throw new Error(`Unexpected request ${input.path}`);
  });

  const unknown = await client.acknowledgeOrderWarning({ replyId: "unknown", confirmed: true });
  assert.equal(unknown.state === "warning" && unknown.warnings[0]?.known, false);
  const known = await client.acknowledgeOrderWarning({ replyId: "known", confirmed: true });
  assert.equal(known.state === "warning" && known.warnings[0]?.known, true);
  const accepted = await client.acknowledgeOrderWarning({ replyId: "final", confirmed: true });
  assert.deepEqual(accepted, {
    state: "accepted",
    orderId: "777",
    status: "WORKING",
    clientOrderId: null,
    warnings: [],
  });
});

void test("fresh lifecycle reads retain combo legs and partial-fill economics", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/accounts") {
      return { accounts: ["U123"], selectedAccount: "U123" };
    }
    if (input.path === "iserver/account/orders") {
      return {
        orders: [
          {
            account: "U123",
            orderId: "777",
            cOID: "huskly-20260729-abc",
            status: "Submitted",
            conidex: "28812380@CME;;;892767804/1,892767774/-1",
            totalSize: 2,
            filledQuantity: 1,
            remainingQuantity: 1,
            avgPrice: -38.5,
            price: -39,
            commissionAndFees: "3.25 USD",
            lastExecutionTime_r: 1785355200000,
          },
        ],
      };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });
  const result = await client.getDerivativeOrderStatus("U123", "777");
  assert.equal(result.status, "PARTIALLY_FILLED");
  assert.equal(result.averagePrice, -38.5);
  assert.equal(result.commissionAndFees, 3.25);
  assert.deepEqual(result.legs, [
    { conid: 892767804, ratio: 1 },
    { conid: 892767774, ratio: -1 },
  ]);
  assert.deepEqual(client.calls.find(({ path }) => path === "iserver/account/orders")?.params, {
    force: true,
    accountId: "U123",
  });
});

void test("lifecycle normalizes terminal filled, canceled, and rejected states", async () => {
  for (const [raw, expected] of [
    ["Filled", "FILLED"],
    ["Cancelled", "CANCELED"],
    ["Inactive", "REJECTED"],
  ] as const) {
    const client = new FakeIbkrClient((input) => {
      if (input.path === "iserver/accounts") {
        return { accounts: ["U123"], selectedAccount: "U123" };
      }
      if (input.path === "iserver/account/orders") {
        return { orders: [{ account: "U123", orderId: "777", status: raw }] };
      }
      throw new Error(`Unexpected request ${input.path}`);
    });
    assert.equal((await client.getDerivativeOrderStatus("U123", "777")).status, expected);
  }
});

void test("cancel sends one explicit request with operator metadata", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/accounts") {
      return { accounts: ["U123"], selectedAccount: "U123" };
    }
    if (input.method === "DELETE") return { msg: "Request was submitted" };
    throw new Error(`Unexpected request ${input.path}`);
  });
  await client.cancelDerivativeOrder({
    accountId: "U123",
    orderId: "777",
    extOperator: "felipecsl",
    manualIndicator: true,
  });
  assert.deepEqual(client.calls.at(-1), {
    path: "iserver/account/U123/order/777",
    method: "DELETE",
    params: { extOperator: "felipecsl", manualIndicator: true },
  });
});
