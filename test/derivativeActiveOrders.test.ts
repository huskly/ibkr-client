import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient } from "../src/ibkr/ibkrClient.js";
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
  constructor(private readonly orders: unknown) {
    super(config);
  }
  protected override sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    if (input.path === "iserver/auth/status") {
      return Promise.resolve({ authenticated: true, competing: false } as T);
    }
    if (input.path === "iserver/accounts") {
      return Promise.resolve({ accounts: ["U123"], selectedAccount: "U123" } as T);
    }
    if (input.path === "iserver/account/orders") return Promise.resolve(this.orders as T);
    throw new Error(`Unexpected request: ${input.path}`);
  }
  protected override wait(_ms: number): Promise<void> {
    return Promise.resolve();
  }
}

void test("lists a typed active single option and preserves lifecycle evidence", async () => {
  const client = new FakeIbkrClient({
    orders: [
      {
        account: "U123",
        orderId: 10,
        cOID: "caller-10",
        conid: 101,
        description1: "SPY   260821C00600000",
        side: "BUY",
        totalSize: 3,
        cumFill: 1,
        remaining: 2,
        status: "Submitted",
        orderType: "LMT",
        price: 1.25,
        tif: "GTC",
        outsideRTH: false,
        orderTime: "2026-07-31T12:00:00Z",
      },
    ],
  });
  const [order] = await client.listActiveDerivativeOrders("U123");
  assert.deepEqual(order, {
    accountId: "U123",
    orderId: "10",
    clientOrderId: "caller-10",
    parentOrderId: null,
    parentClientOrderId: null,
    graphRole: "ROOT",
    status: "PARTIALLY_FILLED",
    totalQuantity: 3,
    filledQuantity: 1,
    remainingQuantity: 2,
    tif: "GTC",
    session: "REGULAR",
    orderType: "LIMIT",
    limitPrice: 1.25,
    stopPrice: null,
    enteredAt: "2026-07-31T12:00:00.000Z",
    updatedAt: null,
    legs: [
      {
        conid: 101,
        ratio: 1,
        side: "BUY",
        quantity: 3,
        option: {
          symbol: "SPY   260821C00600000",
          underlying: "SPY",
          expiry: "2026-08-21",
          strike: 600,
          right: "C",
        },
        uncertainty: [],
      },
    ],
    uncertainty: [],
  });
  assert.deepEqual(client.calls.at(-1)?.params, { force: true, accountId: "U123" });
});

void test("preserves every signed USD combo leg", async () => {
  const client = new FakeIbkrClient({
    orders: [
      {
        account: "U123",
        order_id: "20",
        cOID: "combo",
        conidex: "28812380;;;111/1,222/-2",
        total_size: 4,
        cum_fill: 0,
        remaining: 4,
        order_status: "PreSubmitted",
        order_type: "LMT",
        limit_price: 0.5,
        stopPrice: 0.2,
        tif: "DAY",
        outside_rth: true,
        lastExecutionTime: "2026-07-31T12:01:00Z",
      },
    ],
  });
  const [order] = await client.listActiveDerivativeOrders("U123");
  assert.deepEqual(
    order?.legs.map(({ conid, ratio, side, quantity }) => ({ conid, ratio, side, quantity })),
    [
      { conid: 111, ratio: 1, side: "BUY", quantity: 4 },
      { conid: 222, ratio: -2, side: "SELL", quantity: 8 },
    ]
  );
  assert.equal(order?.updatedAt, "2026-07-31T12:01:00.000Z");
  assert.equal(order?.session, "OVERNIGHT");
  assert.equal(order?.status, "WORKING");
});

void test("retains nested contingent ownership and reports graph uncertainty", async () => {
  const client = new FakeIbkrClient({
    orders: [
      {
        account: "U123",
        orderId: 30,
        cOID: "parent",
        conid: 301,
        side: "SELL",
        totalSize: 1,
        filled: 0,
        remaining: 1,
        status: "Submitted",
        childOrders: [
          {
            account: "U123",
            orderId: 31,
            conid: 302,
            side: "BUY",
            totalSize: 1,
            filled: 0,
            remaining: 1,
            status: "MysteryStatus",
          },
        ],
      },
    ],
  });
  const [, child] = await client.listActiveDerivativeOrders("U123");
  assert.equal(child?.graphRole, "CHILD");
  assert.equal(child?.parentOrderId, "30");
  assert.equal(child?.parentClientOrderId, "parent");
  assert.deepEqual(child?.uncertainty, ["UNKNOWN_STATUS", "PARTIAL_GRAPH"]);
});

void test("malformed, aggregate-only, missing-parent, and duplicate members stay visible", async () => {
  const client = new FakeIbkrClient({
    orders: [
      {
        account: "U123",
        orderId: 40,
        conidex: "28812380;;;bad",
        totalSize: 1,
        filled: 0,
        remaining: 1,
        status: "Submitted",
      },
      {
        account: "U123",
        orderId: 41,
        conidex: "28812380;;;",
        totalSize: 1,
        filled: 0,
        remaining: 1,
        status: "Submitted",
        parentId: "gone",
      },
      {
        account: "U123",
        orderId: 42,
        conid: 420,
        totalSize: 1,
        filled: 0,
        remaining: 1,
        status: "Submitted",
      },
      { account: "U123", orderId: 42, totalSize: 1, filled: 0, remaining: 1, status: "Submitted" },
    ],
  });
  const orders = await client.listActiveDerivativeOrders("U123");
  assert.ok(orders[0]?.uncertainty.includes("MALFORMED_CONIDEX"));
  assert.deepEqual(orders[0]?.legs[0]?.conid, null);
  assert.ok(orders[1]?.uncertainty.includes("AGGREGATE_ONLY"));
  assert.ok(orders[1]?.uncertainty.includes("MISSING_PARENT"));
  assert.ok(orders[2]?.uncertainty.includes("DUPLICATE_MEMBER"));
  assert.ok(orders[3]?.uncertainty.includes("DUPLICATE_MEMBER"));
  assert.ok(orders[3]?.uncertainty.includes("MISSING_LEG_IDENTITY"));
});

void test("fails closed when the scoped response contains another account", async () => {
  const client = new FakeIbkrClient({ orders: [{ account: "OTHER", orderId: 50 }] });
  await assert.rejects(
    client.listActiveDerivativeOrders("U123"),
    /contained an order for another account/
  );
});
