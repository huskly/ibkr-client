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
  constructor(
    private readonly orders: unknown | ((input: RequestInput) => unknown),
    private readonly selectedAccount = "U123",
    private readonly switchResponse: unknown = { set: true, acctId: "U123" }
  ) {
    super(config);
  }
  protected override sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    if (input.path === "iserver/auth/status") {
      return Promise.resolve({ authenticated: true, competing: false } as T);
    }
    if (input.path === "iserver/accounts") {
      return Promise.resolve({ accounts: ["U123"], selectedAccount: this.selectedAccount } as T);
    }
    if (input.path === "iserver/account") return Promise.resolve(this.switchResponse as T);
    if (input.path === "iserver/account/orders") {
      const response = typeof this.orders === "function" ? this.orders(input) : this.orders;
      return Promise.resolve(response as T);
    }
    throw new Error(`Unexpected request: ${input.path}`);
  }
  protected override wait(_ms: number): Promise<void> {
    return Promise.resolve();
  }
}

void test("lists a typed active single option and preserves lifecycle evidence", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
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
  assert.deepEqual(client.calls.at(-1)?.params, { accountId: "U123" });
});

void test("does not miss a live order hidden by a forced empty snapshot", async () => {
  const liveOrder = {
    account: "U123",
    orderId: 99,
    conid: 101,
    side: "BUY",
    totalSize: 1,
    filled: 0,
    remaining: 1,
    status: "Submitted",
  };
  const client = new FakeIbkrClient((input: RequestInput) =>
    input.params?.["force"] === true
      ? { snapshot: true, orders: [] }
      : { snapshot: true, orders: [liveOrder] }
  );

  const orders = await client.listActiveDerivativeOrders("U123");

  assert.deepEqual(
    orders.map(({ orderId }) => orderId),
    ["99"]
  );
  assert.deepEqual(client.calls.at(-1)?.params, { accountId: "U123" });
});

void test("treats a null conidex as absent for a single-leg order", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [
      {
        account: "U123",
        orderId: 11,
        conid: 102,
        conidex: null,
        side: "SELL",
        totalSize: 2,
        filled: 0,
        remaining: 2,
        status: "Submitted",
      },
    ],
  });

  const [order] = await client.listActiveDerivativeOrders("U123");
  assert.deepEqual(order?.legs, [
    {
      conid: 102,
      ratio: -1,
      side: "SELL",
      quantity: 2,
      option: null,
      uncertainty: [],
    },
  ]);
  assert.ok(!order?.uncertainty.includes("MALFORMED_CONIDEX"));
  assert.ok(!order?.uncertainty.includes("AGGREGATE_ONLY"));
});

void test("falls back to conid for a scalar single-leg conidex", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [
      {
        account: "U123",
        orderId: 12,
        conid: 101,
        conidex: "101",
        side: "BUY",
        totalSize: 3,
        filled: 0,
        remaining: 3,
        status: "Submitted",
      },
    ],
  });

  const [order] = await client.listActiveDerivativeOrders("U123");
  assert.deepEqual(order?.legs, [
    {
      conid: 101,
      ratio: 1,
      side: "BUY",
      quantity: 3,
      option: null,
      uncertainty: [],
    },
  ]);
  assert.ok(!order?.uncertainty.includes("MALFORMED_CONIDEX"));
  assert.ok(!order?.uncertainty.includes("AGGREGATE_ONLY"));
});

void test("reads the snake_case stop price of a resting combo STOP child", async () => {
  // Real shape of an attached BAG STOP child on a paper account: IBKR reports `stop_price` as a
  // positive decimal string, and never populates the camelCase `stopPrice` alias.
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [
      {
        account: "U123",
        order_id: "980150332",
        cOID: "pcs-entry-afa2ac2f:root_1",
        parent_order_id: "980150331",
        conidex: "28812380;;;906570511/1,907108616/-1",
        side: "B",
        sec_type: "BAG",
        total_size: "1.0",
        cum_fill: "0.0",
        order_status: "PreSubmitted",
        order_type: "STP",
        limit_price: "",
        stop_price: "2.80",
        tif: "GTC",
      },
    ],
  });
  const [order] = await client.listActiveDerivativeOrders("U123");
  assert.equal(order?.orderType, "STOP");
  assert.equal(order?.stopPrice, 2.8);
  assert.equal(order?.parentOrderId, "980150331");
});

void test("preserves every signed USD combo leg", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [
      {
        account: "U123",
        order_id: "20",
        cOID: "combo",
        conidex: "28812380;;;111/1,222/-2",
        side: "BUY",
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

void test("normalizes exchange-qualified sell combo legs to their effective sides", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [
      {
        account: "U123",
        order_id: "21",
        conidex: "28812380@CME;;;111/1,222/-2",
        side: "SELL",
        total_size: 4,
        cum_fill: 0,
        remaining: 4,
        order_status: "Submitted",
      },
    ],
  });

  const [order] = await client.listActiveDerivativeOrders("U123");
  assert.deepEqual(
    order?.legs.map(({ conid, ratio, side, quantity }) => ({ conid, ratio, side, quantity })),
    [
      { conid: 111, ratio: -1, side: "SELL", quantity: 4 },
      { conid: 222, ratio: 2, side: "BUY", quantity: 8 },
    ]
  );
  assert.ok(!order?.uncertainty.includes("MALFORMED_CONIDEX"));
  assert.ok(!order?.uncertainty.includes("AGGREGATE_ONLY"));
});

void test("preserves a terminal canceled status after a partial fill", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [
      {
        account: "U123",
        order_id: "22",
        conid: 101,
        side: "BUY",
        total_size: 3,
        cum_fill: 1,
        remaining: 2,
        order_status: "Cancelled",
      },
    ],
  });

  const [order] = await client.listActiveDerivativeOrders("U123");
  assert.equal(order?.status, "CANCELED");
});

void test("keeps combo directions unknown when the outer side is absent", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [
      {
        account: "U123",
        order_id: "23",
        conidex: "28812380;;;111/1,222/-2",
        total_size: 4,
        cum_fill: 0,
        remaining: 4,
        order_status: "Submitted",
      },
    ],
  });

  const [order] = await client.listActiveDerivativeOrders("U123");
  assert.deepEqual(
    order?.legs.map(({ conid, ratio, side, quantity, uncertainty }) => ({
      conid,
      ratio,
      side,
      quantity,
      uncertainty,
    })),
    [
      {
        conid: 111,
        ratio: null,
        side: "UNKNOWN",
        quantity: 4,
        uncertainty: ["UNKNOWN_SIDE"],
      },
      {
        conid: 222,
        ratio: null,
        side: "UNKNOWN",
        quantity: 8,
        uncertainty: ["UNKNOWN_SIDE"],
      },
    ]
  );
  assert.ok(order?.uncertainty.includes("UNKNOWN_SIDE"));
});

void test("does not associate combo option identities by description position", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [
      {
        account: "U123",
        order_id: "24",
        conidex: "28812380;;;111/1,222/-1",
        side: "BUY",
        total_size: 1,
        cum_fill: 0,
        remaining: 1,
        order_status: "Submitted",
        orderDescriptionWithContract: "SPY   260821P00550000",
        description1: "SPY   260821C00600000",
        symbol: "SPY   260821P00550000",
      },
    ],
  });

  const [order] = await client.listActiveDerivativeOrders("U123");
  assert.deepEqual(
    order?.legs.map(({ conid, option }) => ({ conid, option })),
    [
      { conid: 111, option: null },
      { conid: 222, option: null },
    ]
  );
});

void test("treats an echoed parentId as the caller-supplied parent identity", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [
      {
        account: "U123",
        orderId: 32,
        parentId: "parent-customer-id",
        conid: 302,
        side: "BUY",
        totalSize: 1,
        filled: 0,
        remaining: 1,
        status: "Submitted",
      },
    ],
  });

  const [child] = await client.listActiveDerivativeOrders("U123");
  assert.equal(child?.graphRole, "CHILD");
  assert.equal(child?.parentOrderId, null);
  assert.equal(child?.parentClientOrderId, "parent-customer-id");
});

void test("retains nested contingent ownership and reports graph uncertainty", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
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
    snapshot: true,
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
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [{ account: "OTHER", orderId: 50 }],
  });
  await assert.rejects(client.listActiveDerivativeOrders("U123"), /unambiguous account identity/);
});

void test("fails closed when an active order omits its account identity", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [{ orderId: 50 }],
  });
  await assert.rejects(client.listActiveDerivativeOrders("U123"), /unambiguous account identity/);
});

void test("fails closed when active order account aliases conflict", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [{ account: "U123", acct: "OTHER", orderId: 50 }],
  });
  await assert.rejects(client.listActiveDerivativeOrders("U123"), /unambiguous account identity/);
});

void test("fails closed when a provided account alias is malformed", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [{ account: 123, acct: "U123", orderId: 50 }],
  });
  await assert.rejects(client.listActiveDerivativeOrders("U123"), /unambiguous account identity/);
});

void test("includes active children from both provider collection aliases", async () => {
  const client = new FakeIbkrClient({
    snapshot: true,
    orders: [
      {
        account: "U123",
        orderId: 50,
        childOrders: [],
        children: [{ account: "U123", orderId: 51, parentOrderId: 50 }],
      },
    ],
  });
  const orders = await client.listActiveDerivativeOrders("U123");
  assert.deepEqual(
    orders.map(({ orderId }) => orderId),
    ["50", "51"]
  );
});

void test("fails closed when an account switch is not acknowledged", async () => {
  const client = new FakeIbkrClient({ snapshot: true, orders: [] }, "OTHER", {
    set: false,
    acctId: "U123",
  });
  await assert.rejects(
    client.listActiveDerivativeOrders("U123"),
    /account switch was not confirmed/
  );
});

void test("fails closed when an account switch acknowledges another account", async () => {
  const client = new FakeIbkrClient({ snapshot: true, orders: [] }, "OTHER", {
    set: true,
    acctId: "OTHER",
  });
  await assert.rejects(
    client.listActiveDerivativeOrders("U123"),
    /account switch was not confirmed/
  );
});

void test("fails closed when the active-order snapshot is incomplete", async () => {
  const client = new FakeIbkrClient({
    snapshot: false,
    orders: [{ account: "U123", orderId: 51 }],
  });
  await assert.rejects(client.listActiveDerivativeOrders("U123"), /snapshot is incomplete/);
});

void test("fails closed when the active-order snapshot marker is absent", async () => {
  const client = new FakeIbkrClient({ orders: [] });
  await assert.rejects(client.listActiveDerivativeOrders("U123"), /snapshot is incomplete/);
});

void test("fails closed when a completed snapshot omits its orders array", async () => {
  const client = new FakeIbkrClient({ snapshot: true });
  await assert.rejects(client.listActiveDerivativeOrders("U123"), /snapshot is incomplete/);
});

void test("fails closed when a completed snapshot has malformed orders", async () => {
  const client = new FakeIbkrClient({ snapshot: true, orders: {} });
  await assert.rejects(client.listActiveDerivativeOrders("U123"), /snapshot is incomplete/);
});
