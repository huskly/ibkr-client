import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient } from "../src/ibkr/ibkrClient.js";
import type { DerivativeContract, DerivativeOrderGraphRequest } from "../src/index.js";
import type { IbkrOauth1Config } from "../src/ibkr/oauthConfig.js";

interface Input {
  path: string;
  method?: string;
  params?: Record<string, string | number | boolean | null | undefined>;
  data?: object;
}
const config: IbkrOauth1Config = {
  accessTokenSecret: "x",
  accessToken: "x",
  consumerKey: "x",
  encryption: "x",
  signature: "x",
  dhPrime: "x",
  realm: "x",
};
class Fake extends IbkrClient {
  calls: Input[] = [];
  constructor(private response: (input: Input) => unknown) {
    super(config);
  }
  protected override sendRequest<T>(input: Input): Promise<T> {
    this.calls.push(input);
    const response = this.response(input);
    if (
      input.path === "iserver/account/orders" &&
      typeof response === "object" &&
      response !== null &&
      !Array.isArray(response) &&
      "orders" in response &&
      !("snapshot" in response)
    ) {
      return Promise.resolve({ ...response, snapshot: true } as T);
    }
    return Promise.resolve(response as T);
  }
  protected override wait(_ms: number): Promise<void> {
    return Promise.resolve();
  }
}
const contract = (conid: number): DerivativeContract => ({
  conid,
  assetClass: "OPT",
  underlying: "SPY",
  expiration: "2026-08-21",
  strike: 600,
  right: "P",
  tradingClass: "SPY",
  exchange: "SMART",
  multiplier: 100,
});
const graph = (): DerivativeOrderGraphRequest => ({
  accountId: "U1",
  rootClientOrderId: "pcs-42",
  nodes: [
    {
      memberId: "entry",
      accountId: "U1",
      legs: [
        { contract: contract(1), ratio: -1 },
        { contract: contract(2), ratio: 1 },
      ],
      quantity: 1,
      orderType: "LMT",
      priceEffect: "CREDIT",
      limit: 1.2,
      tif: "DAY",
      session: "REGULAR",
    },
    {
      memberId: "stop",
      parentMemberId: "entry",
      accountId: "U1",
      contract: contract(1),
      side: "BUY",
      quantity: 1,
      orderType: "STP",
      stopPrice: 2.4,
      tif: "GTC",
      session: "REGULAR",
    },
    {
      memberId: "hedge",
      parentMemberId: "entry",
      accountId: "U1",
      contract: contract(2),
      side: "SELL",
      quantity: 1,
      orderType: "MKT",
      tif: "DAY",
      session: "REGULAR",
    },
  ],
});
const graphTwoNodes = (): DerivativeOrderGraphRequest => {
  const full = graph();
  return {
    ...full,
    nodes: [full.nodes[0]!, full.nodes[1]!] as const,
  };
};
/**
 * A BAG parent with a BAG STOP child, same conidex with reversed ratios - the 2-level shape
 * huskly/strategy-terminal#527 needs because IBKR rejects a combo parent with a non-combo child.
 */
const comboStopGraph = (): DerivativeOrderGraphRequest => ({
  accountId: "U1",
  rootClientOrderId: "pcs-42",
  nodes: [
    {
      memberId: "entry",
      accountId: "U1",
      legs: [
        { contract: contract(1), ratio: -1 },
        { contract: contract(2), ratio: 1 },
      ],
      quantity: 1,
      orderType: "LMT",
      priceEffect: "CREDIT",
      limit: 1.2,
      tif: "DAY",
      session: "REGULAR",
    },
    {
      memberId: "stop",
      parentMemberId: "entry",
      accountId: "U1",
      legs: [
        { contract: contract(1), ratio: 1 },
        { contract: contract(2), ratio: -1 },
      ],
      quantity: 1,
      orderType: "STP",
      priceEffect: "DEBIT",
      stopPrice: 2.4,
      tif: "GTC",
      session: "REGULAR",
    },
  ],
});
const nestedGraph = (): DerivativeOrderGraphRequest => {
  const request = graph();
  request.nodes[2]!.parentMemberId = "stop";
  return request;
};
const recoveredTerminalRootStatus = (orderId: string): Record<string, unknown> => ({
  account: "U1",
  order_id: orderId,
  orderId,
  cOID: "pcs-42",
  order_status: "Filled",
  conidex: "28812380;;;1/-1,2/1",
  orderType: "LMT",
  side: "BUY",
  totalSize: 1,
  limitPrice: -1.2,
  filled: 1,
  remaining: 0,
  tif: "DAY",
  outsideRTH: false,
});
const recoveredTerminalOrderStatus = (parentId = "pcs-42"): Record<string, unknown> => ({
  account: "U1",
  orderId: "12",
  order_id: "12",
  parentId,
  order_status: "Filled",
  conid: 2,
  orderType: "MKT",
  side: "SELL",
  totalSize: 1,
  filled: 1,
  remaining: 0,
  tif: "DAY",
  outsideRTH: false,
});
const liveRoot = (): Record<string, unknown> => ({
  account: "U1",
  order_id: "10",
  order_status: "Submitted",
  cOID: "pcs-42",
  conidex: "28812380;;;1/-1,2/1",
  orderType: "LMT",
  side: "BUY",
  totalSize: 1,
  limitPrice: -1.2,
  tif: "DAY",
  outsideRTH: false,
});
const session = (input: Input): unknown =>
  input.path === "iserver/auth/status"
    ? { authenticated: true, competing: false }
    : input.path === "iserver/accounts"
      ? { accounts: ["U1"], selectedAccount: "U1", isPaper: true }
      : undefined;

test("submits combo, STOP, and MARKET graph with exact activation links", async () => {
  const client = new Fake((input) =>
    input.path.endsWith("/orders") && input.method === "POST"
      ? [
          { order_id: "10", order_status: "Submitted", local_order_id: "pcs-42" },
          { order_id: "11", order_status: "Submitted", local_order_id: "pcs-42:stop" },
          { order_id: "12", order_status: "Submitted", local_order_id: "pcs-42:hedge" },
        ]
      : session(input)
  );
  const result = await client.submitDerivativeOrderGraph(graph());
  assert.equal(result.state, "accepted");
  assert.deepEqual(
    result.members.map((m) => [m.role, m.orderId, m.parentOrderId]),
    [
      ["root", "10", null],
      ["child", "11", "10"],
      ["child", "12", "10"],
    ]
  );
  assert.equal(result.rootClientOrderId, "pcs-42");
  const data = client.calls.find((c) => c.method === "POST" && c.path.endsWith("/orders"))
    ?.data as { orders: Record<string, unknown>[] };
  assert.equal(data.orders[0]?.["cOID"], "pcs-42");
  assert.equal(data.orders[1]?.["parentId"], "pcs-42");
  assert.equal(data.orders[1]?.["cOID"], "pcs-42:stop");
  assert.equal(data.orders[2]?.["parentId"], "pcs-42");
  assert.equal(data.orders[2]?.["cOID"], "pcs-42:hedge");
  assert.equal(data.orders[2]?.["orderType"], "MKT");
  assert.equal("price" in data.orders[2]!, false);
});

test("submits a BAG STOP child with the same conidex and reversed ratios", async () => {
  const client = new Fake((input) =>
    input.path.endsWith("/orders") && input.method === "POST"
      ? [
          { order_id: "10", order_status: "Submitted", local_order_id: "pcs-42" },
          { order_id: "11", order_status: "PreSubmitted", local_order_id: "pcs-42:stop" },
        ]
      : session(input)
  );
  const result = await client.submitDerivativeOrderGraph(comboStopGraph());
  assert.equal(result.state, "accepted");
  assert.deepEqual(
    result.members.map((m) => [m.role, m.orderId, m.parentOrderId]),
    [
      ["root", "10", null],
      ["child", "11", "10"],
    ]
  );
  const data = client.calls.find((c) => c.method === "POST" && c.path.endsWith("/orders"))
    ?.data as { orders: Record<string, unknown>[] };
  assert.deepEqual(data.orders[0], {
    acctId: "U1",
    conidex: "28812380;;;1/-1,2/1",
    orderType: "LMT",
    price: -1.2,
    side: "BUY",
    tif: "DAY",
    quantity: 1,
    outsideRTH: false,
    cOID: "pcs-42",
  });
  assert.deepEqual(data.orders[1], {
    acctId: "U1",
    conidex: "28812380;;;1/1,2/-1",
    orderType: "STP",
    price: 2.4,
    side: "BUY",
    tif: "GTC",
    quantity: 1,
    outsideRTH: false,
    cOID: "pcs-42:stop",
    parentId: "pcs-42",
  });
});

test("correlates reordered graph acknowledgements by echoed client order ID", async () => {
  const client = new Fake((input) =>
    input.path.endsWith("/orders") && input.method === "POST"
      ? [
          {
            order_id: "11",
            order_status: "PreSubmitted",
            local_order_id: "pcs-42:stop",
          },
          { order_id: "10", order_status: "Submitted", cOID: "pcs-42" },
        ]
      : session(input)
  );

  const result = await client.submitDerivativeOrderGraph(comboStopGraph());

  assert.equal(result.state, "accepted");
  assert.deepEqual(
    result.members.map(({ memberId, orderId, parentOrderId }) => [
      memberId,
      orderId,
      parentOrderId,
    ]),
    [
      ["entry", "10", null],
      ["stop", "11", "10"],
    ]
  );
});

test("does not correlate graph acknowledgements without echoed identity", async () => {
  const client = new Fake((input) =>
    input.path.endsWith("/orders") && input.method === "POST"
      ? [
          { order_id: "11", order_status: "PreSubmitted" },
          { order_id: "10", order_status: "Submitted" },
        ]
      : session(input)
  );

  const result = await client.submitDerivativeOrderGraph(comboStopGraph());

  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.deepEqual(
    result.members.map(({ orderId }) => orderId),
    [null, null]
  );
  assert.deepEqual(
    result.unrecognizedResponses.map((response) => (response as { order_id: string }).order_id),
    ["11", "10"]
  );
});

test("fails closed on conflicting echoed identities and keeps raw evidence", async () => {
  const client = new Fake((input) =>
    input.path.endsWith("/orders") && input.method === "POST"
      ? [
          {
            order_id: "10",
            order_status: "Submitted",
            local_order_id: "pcs-42",
            cOID: "different-root",
          },
          {
            order_id: "11",
            order_status: "PreSubmitted",
            local_order_id: "pcs-42:stop",
          },
        ]
      : session(input)
  );

  const result = await client.submitDerivativeOrderGraph(comboStopGraph());

  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.match(result.reasons[0] ?? "", /unique client order identity/);
  assert.equal(result.members[0]?.orderId, null);
  assert.equal(result.members[1]?.orderId, "11");
  assert.deepEqual(result.unrecognizedResponses, [
    {
      order_id: "10",
      order_status: "Submitted",
      local_order_id: "pcs-42",
      cOID: "different-root",
    },
  ]);
});

test("warning continuation is restart-safe and supports chained replies", async () => {
  let reply = 0;
  const client = new Fake((input) => {
    if (input.path.endsWith("/orders") && input.method === "POST")
      return [{ id: "w1", message: ["warning"], messageIds: ["o163"] }];
    if (input.path.startsWith("iserver/reply/"))
      return ++reply === 1
        ? [{ id: "w2", message: ["again"], messageIds: ["o163"] }]
        : [
            { order_id: "10", order_status: "Submitted", local_order_id: "pcs-42" },
            {
              order_id: "11",
              order_status: "Submitted",
              local_order_id: "pcs-42:stop",
            },
            {
              order_id: "12",
              order_status: "Submitted",
              local_order_id: "pcs-42:hedge",
            },
          ];
    return session(input);
  });
  const first = await client.submitDerivativeOrderGraph(graph());
  assert.equal(first.state, "warning");
  if (first.state !== "warning") return;
  const persisted = JSON.parse(JSON.stringify(first.continuation)) as typeof first.continuation;
  const second = await client.acknowledgeDerivativeOrderGraphWarning({
    continuation: persisted,
    confirmed: true,
  });
  assert.equal(second.state, "warning");
  if (second.state !== "warning") return;
  const accepted = await client.acknowledgeDerivativeOrderGraphWarning({
    continuation: second.continuation,
    confirmed: true,
  });
  assert.equal(accepted.state, "accepted");
  assert.equal(client.calls.filter((c) => c.path.startsWith("iserver/reply/")).length, 2);
});

test("warning acknowledgement rechecks brokerage session safety before replying", async () => {
  let competing = false;
  const client = new Fake((input) => {
    if (input.path === "iserver/auth/status") return { authenticated: true, competing };
    if (input.path.endsWith("/orders") && input.method === "POST")
      return [{ id: "w1", message: ["warning"] }];
    if (input.path.startsWith("iserver/reply/")) throw new Error("unsafe reply attempted");
    return session(input);
  });
  const first = await client.submitDerivativeOrderGraph(graph());
  assert.equal(first.state, "warning");
  if (first.state !== "warning") return;

  competing = true;
  await assert.rejects(
    () =>
      client.acknowledgeDerivativeOrderGraphWarning({
        continuation: first.continuation,
        confirmed: true,
      }),
    /not safely authenticated/
  );
  assert.equal(client.calls.filter((call) => call.path.startsWith("iserver/reply/")).length, 0);
});

test("partial and duplicated graph acknowledgements fail closed", async () => {
  for (const response of [
    [{ order_id: "10", order_status: "Submitted" }],
    [
      { order_id: "10", order_status: "Submitted" },
      { order_id: "10", order_status: "Submitted" },
      { order_id: "12", order_status: "Submitted" },
    ],
  ]) {
    const client = new Fake((input) =>
      input.path.endsWith("/orders") && input.method === "POST" ? response : session(input)
    );
    const result = await client.submitDerivativeOrderGraph(graph());
    assert.equal(result.state, "recovery_required");
    if (result.state !== "recovery_required") continue;
    assert.deepEqual(
      result.members.map(({ orderId }) => orderId),
      [null, null, null]
    );
    assert.deepEqual(
      result.unrecognizedResponses.map((item) => (item as { order_id: string }).order_id),
      response.map((item) => item.order_id)
    );
  }
});

test("accepts nested child acknowledgements from children and childOrders collections", async () => {
  for (const childKey of ["children", "childOrders"] as const) {
    const client = new Fake((input) =>
      input.path.endsWith("/orders") && input.method === "POST"
        ? [
            {
              order_id: "10",
              order_status: "Submitted",
              local_order_id: "pcs-42",
              [childKey]: [
                {
                  order_id: "11",
                  order_status: "PreSubmitted",
                  local_order_id: "pcs-42:stop",
                },
              ],
            },
          ]
        : session(input)
    );

    const result = await client.submitDerivativeOrderGraph(comboStopGraph());

    assert.equal(result.state, "accepted", childKey);
    assert.deepEqual(
      result.members.map(({ memberId, orderId, parentOrderId }) => [
        memberId,
        orderId,
        parentOrderId,
      ]),
      [
        ["entry", "10", null],
        ["stop", "11", "10"],
      ]
    );
  }
});

test("partial graph acknowledgements never report accepted and name members without order IDs", async () => {
  const client = new Fake((input) =>
    input.path.endsWith("/orders") && input.method === "POST"
      ? [{ order_id: "10", order_status: "Filled", local_order_id: "pcs-42" }]
      : session(input)
  );

  const result = await client.submitDerivativeOrderGraph(comboStopGraph());

  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.deepEqual(
    result.members.map(({ memberId, orderId }) => [memberId, orderId]),
    [
      ["entry", "10"],
      ["stop", null],
    ]
  );
  assert.match(result.reasons[0] ?? "", /missing broker order IDs for member\(s\): stop/);
  assert.equal(
    result.members.filter(({ orderId }) => orderId !== null).length,
    1,
    "partial evidence retains the known member ID without claiming full acceptance"
  );
});

test("malformed nested child collections fail closed without dropping the parent acknowledgement", async () => {
  const client = new Fake((input) =>
    input.path.endsWith("/orders") && input.method === "POST"
      ? [
          {
            order_id: "10",
            order_status: "Submitted",
            local_order_id: "pcs-42",
            children: { order_id: "11", local_order_id: "pcs-42:stop" },
          },
        ]
      : session(input)
  );

  const result = await client.submitDerivativeOrderGraph(comboStopGraph());

  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.equal(result.members[0]?.orderId, "10");
  assert.equal(result.members[1]?.orderId, null);
  assert.match(result.reasons[0] ?? "", /missing broker order IDs for member\(s\): stop/);
  assert.equal(result.unrecognizedResponses.length > 0, true);
});

test("invalid graph fails before broker access and transport placement is attempted once", async () => {
  const invalid = graph();
  invalid.nodes[2]!.parentMemberId = "missing";
  const client = new Fake(() => {
    throw new Error("network");
  });
  await assert.rejects(() => client.submitDerivativeOrderGraph(invalid), /parents must precede/);
  assert.equal(client.calls.length, 0);
  const transport = new Fake((input) => {
    if (input.path.endsWith("/orders") && input.method === "POST") throw new Error("network");
    return session(input);
  });
  await assert.rejects(() => transport.submitDerivativeOrderGraph(graph()), /network/);
  assert.equal(
    transport.calls.filter((c) => c.path.endsWith("/orders") && c.method === "POST").length,
    1
  );
});

test("submits a root, child, and grandchild with exact activation links", async () => {
  const client = new Fake((input) =>
    input.path.endsWith("/orders") && input.method === "POST"
      ? [
          { order_id: "10", order_status: "Submitted", local_order_id: "pcs-42" },
          { order_id: "11", order_status: "Submitted", local_order_id: "pcs-42:stop" },
          { order_id: "12", order_status: "Submitted", local_order_id: "pcs-42:hedge" },
        ]
      : session(input)
  );
  const result = await client.submitDerivativeOrderGraph(nestedGraph());
  assert.equal(result.state, "accepted");
  assert.deepEqual(
    result.members.map(({ role, parentMemberId, parentOrderId }) => [
      role,
      parentMemberId,
      parentOrderId,
    ]),
    [
      ["root", null, null],
      ["child", "entry", "10"],
      ["grandchild", "stop", "11"],
    ]
  );
  const data = client.calls.find((call) => call.method === "POST" && call.path.endsWith("/orders"))
    ?.data as { orders: Record<string, unknown>[] };
  assert.deepEqual(
    data.orders.map((order) => [order["cOID"], order["parentId"]]),
    [
      ["pcs-42", undefined],
      ["pcs-42:stop", "pcs-42"],
      ["pcs-42:hedge", "pcs-42:stop"],
    ]
  );
});

test("retains the readable paper rejection for an unregistered grandchild parent ID", async () => {
  const text = "Order couldn't be submitted: Parent order ID=raw-probe-1:root_1 isn't recognized.";
  const client = new Fake((input) =>
    input.path.endsWith("/orders") && input.method === "POST"
      ? [
          { order_id: "-1", order_status: "Failed", error: null, warning_message: "-1", text },
          {
            order_id: "2088581830",
            order_status: "Inactive",
            local_order_id: "raw-probe-1",
          },
        ]
      : session(input)
  );

  const result = await client.submitDerivativeOrderGraph(nestedGraph());

  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.equal(result.errors[0]?.message, text);
  assert.deepEqual(result.errors[0]?.details, {
    order_id: "-1",
    order_status: "Failed",
    error: null,
    warning_message: "-1",
    text,
  });
  assert.match(result.reasons[0] ?? "", /Parent order ID=raw-probe-1:root_1 isn't recognized/);
});

test("retains graph member IDs when a terminal acknowledgement includes rejection text", async () => {
  const client = new Fake((input) =>
    input.path.endsWith("/orders") && input.method === "POST"
      ? [
          {
            order_id: "11",
            order_status: "Rejected",
            local_order_id: "pcs-42:stop",
            text: "STOP order was rejected",
          },
          { order_id: "12", order_status: "Submitted", local_order_id: "pcs-42:hedge" },
          { order_id: "10", order_status: "Submitted", local_order_id: "pcs-42" },
        ]
      : session(input)
  );

  const result = await client.submitDerivativeOrderGraph(nestedGraph());

  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.deepEqual(
    result.members.map(({ memberId, orderId, parentOrderId }) => [
      memberId,
      orderId,
      parentOrderId,
    ]),
    [
      ["entry", "10", null],
      ["stop", "11", "10"],
      ["hedge", "12", "11"],
    ]
  );
  assert.equal(result.errors[0]?.message, "STOP order was rejected");
  assert.deepEqual(result.unrecognizedResponses, []);
});

test("recovers exact graph from root or a known broker identity", async () => {
  const orders = {
    orders: [
      liveRoot(),
      {
        account: "U1",
        order_id: "11",
        order_status: "Submitted",
        conid: 1,
        orderType: "STP",
        side: "BUY",
        totalSize: 1,
        stopPrice: 2.4,
        parentId: "pcs-42",
      },
      {
        account: "U1",
        order_id: "12",
        order_status: "Submitted",
        conid: 2,
        orderType: "MKT",
        side: "SELL",
        totalSize: 1,
        parentId: "pcs-42",
      },
    ],
  };
  const client = new Fake((input) =>
    input.path === "iserver/account/orders" ? orders : session(input)
  );
  assert.equal(
    (
      await client.recoverDerivativeOrderGraph(
        { accountId: "U1", rootClientOrderId: "pcs-42" },
        graph()
      )
    ).state,
    "accepted"
  );
  assert.equal(
    (await client.recoverDerivativeOrderGraph({ accountId: "U1", orderId: "11" }, graph())).state,
    "accepted"
  );
  assert.deepEqual(
    client.calls
      .filter(({ path }) => path === "iserver/account/orders")
      .map(({ params }) => params),
    [
      { accountId: "U1" },
      { accountId: "U1", filters: "filled" },
      { accountId: "U1", filters: "cancelled" },
      { accountId: "U1", filters: "inactive" },
      { accountId: "U1" },
      { accountId: "U1", filters: "filled" },
      { accountId: "U1", filters: "cancelled" },
      { accountId: "U1", filters: "inactive" },
    ]
  );
});

test("recovers an active grandchild through its exact parent identity", async () => {
  const client = new Fake((input) =>
    input.path === "iserver/account/orders"
      ? {
          orders: [
            liveRoot(),
            {
              account: "U1",
              order_id: "11",
              order_status: "Submitted",
              conid: 1,
              orderType: "STP",
              side: "BUY",
              totalSize: 1,
              stopPrice: 2.4,
              parentId: "pcs-42",
            },
            {
              account: "U1",
              order_id: "12",
              order_status: "Submitted",
              conid: 2,
              orderType: "MKT",
              side: "SELL",
              totalSize: 1,
              parentId: "pcs-42:stop",
            },
          ],
        }
      : session(input)
  );

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    nestedGraph()
  );
  assert.equal(result.state, "accepted");
  assert.deepEqual(
    result.members.map(({ memberId, orderId, parentOrderId }) => [
      memberId,
      orderId,
      parentOrderId,
    ]),
    [
      ["entry", "10", null],
      ["stop", "11", "10"],
      ["hedge", "12", "11"],
    ]
  );
});

test("fails closed when a recovered non-root node has a different client order ID", async () => {
  const client = new Fake((input) =>
    input.path === "iserver/account/orders"
      ? {
          orders: [
            liveRoot(),
            {
              account: "U1",
              order_id: "11",
              order_status: "Submitted",
              conid: 1,
              orderType: "STP",
              side: "BUY",
              totalSize: 1,
              stopPrice: 2.4,
              parentId: "pcs-42",
              cOID: "unrelated-stop",
            },
            {
              account: "U1",
              order_id: "12",
              order_status: "Submitted",
              conid: 2,
              orderType: "MKT",
              side: "SELL",
              totalSize: 1,
              parentId: "pcs-42:stop",
              cOID: "pcs-42:hedge",
            },
          ],
        }
      : session(input)
  );

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    nestedGraph()
  );

  assert.equal(result.state, "recovery_required");
  assert.equal(result.members[1]?.orderId, null);
});

test("nested recovery rejects a flattened grandchild parent identity", async () => {
  const client = new Fake((input) =>
    input.path === "iserver/account/orders"
      ? {
          orders: [
            liveRoot(),
            {
              account: "U1",
              order_id: "11",
              order_status: "Submitted",
              conid: 1,
              orderType: "STP",
              side: "BUY",
              totalSize: 1,
              stopPrice: 2.4,
              parentId: "pcs-42",
            },
            {
              account: "U1",
              order_id: "12",
              order_status: "Submitted",
              conid: 2,
              orderType: "MKT",
              side: "SELL",
              totalSize: 1,
              parentId: "pcs-42",
            },
          ],
        }
      : session(input)
  );

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    nestedGraph()
  );
  assert.equal(result.state, "recovery_required");
  assert.equal(result.members[2]?.orderId, null);
});

test("recovery preserves partial fills reported by live orders", async () => {
  const client = new Fake((input) =>
    input.path === "iserver/account/orders"
      ? {
          orders: [
            liveRoot(),
            {
              account: "U1",
              order_id: "11",
              order_status: "Submitted",
              conid: 1,
              orderType: "STP",
              side: "BUY",
              totalSize: 1,
              stopPrice: 2.4,
              parentId: "pcs-42",
              cum_fill: 1,
              remaining: 2,
            },
            {
              account: "U1",
              order_id: "12",
              order_status: "Submitted",
              conid: 2,
              orderType: "MKT",
              side: "SELL",
              totalSize: 1,
              parentId: "pcs-42",
            },
          ],
        }
      : session(input)
  );
  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graph()
  );
  assert.equal(result.state, "accepted");
  assert.equal(result.members[1]?.status, "PARTIALLY_FILLED");
});

test("recovery fails closed when broker parent links are absent or incorrect", async () => {
  for (const childParentId of [undefined, "different-parent"]) {
    const client = new Fake((input) =>
      input.path === "iserver/account/orders"
        ? {
            orders: [
              liveRoot(),
              {
                account: "U1",
                order_id: "11",
                order_status: "Submitted",
                conid: 1,
                orderType: "STP",
                side: "BUY",
                totalSize: 1,
                stopPrice: 2.4,
                ...(childParentId === undefined ? {} : { parentId: childParentId }),
              },
              {
                account: "U1",
                order_id: "12",
                order_status: "Submitted",
                conid: 2,
                orderType: "MKT",
                side: "SELL",
                totalSize: 1,
                parentId: "pcs-42",
              },
            ],
          }
        : session(input)
    );
    const result = await client.recoverDerivativeOrderGraph(
      { accountId: "U1", rootClientOrderId: "pcs-42" },
      graph()
    );
    assert.equal(result.state, "recovery_required");
    assert.equal(result.members[1]?.parentOrderId, null);
  }
});

test("recovery distinguishes same-contract bracket siblings by their complete tickets", async () => {
  const request = graph();
  request.nodes = [
    request.nodes[0]!,
    request.nodes[1]!,
    {
      memberId: "profit",
      parentMemberId: "entry",
      accountId: "U1",
      contract: contract(1),
      side: "BUY",
      quantity: 1,
      orderType: "LMT",
      limit: 0.6,
      tif: "GTC",
      session: "REGULAR",
    },
  ];
  const client = new Fake((input) =>
    input.path === "iserver/account/orders"
      ? {
          orders: [
            liveRoot(),
            {
              account: "U1",
              order_id: "11",
              order_status: "Submitted",
              conid: 1,
              order_type: "STP",
              side: "B",
              total_size: "1",
              stopPrice: "2.4",
              parentId: "pcs-42",
            },
            {
              account: "U1",
              order_id: "12",
              order_status: "Submitted",
              conid: 1,
              order_type: "LMT",
              side: "BUY",
              total_size: "1",
              limit_price: "0.6",
              parentId: "pcs-42",
            },
          ],
        }
      : session(input)
  );

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", orderId: "12" },
    request
  );
  assert.equal(result.state, "accepted");
  assert.deepEqual(
    result.members.map(({ memberId, orderId }) => [memberId, orderId]),
    [
      ["entry", "10"],
      ["stop", "11"],
      ["profit", "12"],
    ]
  );
});

test("recovery distinguishes combo siblings by quantity and signed limit price", async () => {
  const request = graph();
  const root = request.nodes[0]!;
  if (!("legs" in root)) throw new Error("Expected a combo root fixture");
  if (root.orderType !== "LMT") throw new Error("Expected a LIMIT combo root fixture");
  request.nodes = [
    root,
    {
      ...root,
      memberId: "replacement",
      parentMemberId: "entry",
      quantity: 2,
      limit: 0.8,
    },
    {
      ...root,
      memberId: "roll",
      parentMemberId: "entry",
      quantity: 3,
      limit: 0.7,
    },
  ];
  const client = new Fake((input) =>
    input.path === "iserver/account/orders"
      ? {
          orders: [
            liveRoot(),
            {
              account: "U1",
              order_id: "11",
              order_status: "Submitted",
              conidex: "28812380;;;1/-1,2/1",
              orderType: "LMT",
              side: "BUY",
              totalSize: 2,
              limitPrice: -0.8,
              parentId: "pcs-42",
            },
            {
              account: "U1",
              order_id: "12",
              order_status: "Submitted",
              conidex: "28812380;;;1/-1,2/1",
              orderType: "LMT",
              side: "BUY",
              totalSize: 3,
              limitPrice: -0.7,
              parentId: "pcs-42",
            },
          ],
        }
      : session(input)
  );

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    request
  );
  assert.equal(result.state, "accepted");
  assert.deepEqual(
    result.members.map(({ memberId, orderId }) => [memberId, orderId]),
    [
      ["entry", "10"],
      ["replacement", "11"],
      ["roll", "12"],
    ]
  );
});

test("recovers a filled root from terminal evidence after it leaves the active list", async () => {
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders")
      return {
        orders: [
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
        ],
      };
    if (input.path === "iserver/account/trades")
      return [
        {
          execution_id: "exec-root",
          account: "U1",
          order_ref: "pcs-42",
          order_id: "10",
          conid: 1,
          conidex: "28812380;;;1/-1,2/1",
          size: 1,
        },
      ];
    if (input.path === "iserver/account/order/status/10") return recoveredTerminalRootStatus("10");
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "accepted");
  if (result.state !== "accepted") return;
  assert.deepEqual(
    result.members.map(({ memberId, orderId, status }) => [memberId, orderId, status]),
    [
      ["entry", "10", "FILLED"],
      ["stop", "11", "WORKING"],
    ]
  );
  assert.equal(
    client.calls.some((call) => call.path === "iserver/account/order/status/10"),
    true
  );
});

test("recovers mixed active and terminal descendants in one graph", async () => {
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders")
      return {
        orders: [
          liveRoot(),
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
        ],
      };
    if (input.path === "iserver/account/trades")
      return [
        {
          execution_id: "exec-hedge",
          account: "U1",
          parent_order_ref: "pcs-42:stop",
          order_id: "12",
          conid: 2,
          size: 1,
        },
      ];
    if (input.path === "iserver/account/order/status/12")
      return recoveredTerminalOrderStatus("pcs-42:stop");
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    nestedGraph()
  );
  assert.equal(result.state, "accepted");
  if (result.state !== "accepted") return;
  assert.deepEqual(
    result.members.map(({ memberId, orderId, status }) => [memberId, orderId, status]),
    [
      ["entry", "10", "WORKING"],
      ["stop", "11", "WORKING"],
      ["hedge", "12", "FILLED"],
    ]
  );
});

test("reconciles terminal evidence for members selected from the active snapshot", async () => {
  const terminalRoot = recoveredTerminalRootStatus("10");
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "filled") return { orders: [terminalRoot] };
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return {
        orders: [
          liveRoot(),
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/10") return terminalRoot;
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "accepted");
  if (result.state !== "accepted") return;
  assert.deepEqual(
    result.members.map(({ memberId, orderId, status }) => [memberId, orderId, status]),
    [
      ["entry", "10", "FILLED"],
      ["stop", "11", "WORKING"],
    ]
  );
});

test("discovers terminal members from filtered order snapshots without executions", async () => {
  const terminalRoot = {
    ...recoveredTerminalRootStatus("10"),
    order_status: "Cancelled",
    filled: 0,
    remaining: 1,
  };
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "cancelled") return { orders: [terminalRoot] };
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return {
        orders: [
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/10") return undefined;
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "accepted");
  if (result.state !== "accepted") return;
  assert.equal(result.members[0]?.status, "CANCELED");
  assert.equal(result.members[0]?.orderId, "10");
  assert.equal(
    client.calls.some(
      (call) => call.path === "iserver/account/orders" && call.params?.["filters"] === "cancelled"
    ),
    true
  );
});

test("fails closed when terminal status evidence has the wrong identity", async () => {
  for (const status of [
    { account: "U1", order_id: "99", orderId: "99" },
    { account: "U2", order_id: "10", orderId: "10" },
  ]) {
    const client = new Fake((input) => {
      if (input.path === "iserver/account/orders") return { orders: [] };
      if (input.path === "iserver/account/trades")
        return [{ account: "U1", order_ref: "pcs-42", order_id: "10" }];
      if (input.path === "iserver/account/order/status/10") {
        return {
          ...recoveredTerminalRootStatus(String(status.order_id)),
          ...status,
        };
      }
      return session(input);
    });

    const result = await client.recoverDerivativeOrderGraph(
      { accountId: "U1", rootClientOrderId: "pcs-42" },
      graphTwoNodes()
    );
    assert.equal(result.state, "recovery_required");
    if (result.state !== "recovery_required") continue;
    assert.equal(result.unrecognizedResponses.length > 0, true);
  }
});

test("fails closed when recovered terminal status is unknown", async () => {
  const terminalRoot = {
    ...recoveredTerminalRootStatus("10"),
    order_status: "BrokerSpecificTerminalState",
  };
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "cancelled") return { orders: [terminalRoot] };
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return {
        orders: [
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/10") return undefined;
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
  assert.equal(result.members[0]?.status, "UNKNOWN");
});

test("fails closed when terminal evidence includes an unexpected attached order", async () => {
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "cancelled") {
        return {
          orders: [
            {
              account: "U1",
              order_id: "13",
              order_status: "Cancelled",
              conid: 3,
              orderType: "MKT",
              side: "SELL",
              totalSize: 1,
              parentId: "pcs-42",
            },
          ],
        };
      }
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return {
        orders: [
          liveRoot(),
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
          {
            account: "U1",
            order_id: "12",
            order_status: "Submitted",
            conid: 2,
            orderType: "MKT",
            side: "SELL",
            totalSize: 1,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graph()
  );
  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.equal(
    result.unrecognizedResponses.some(
      (item) => typeof item === "object" && item !== null && "order_id" in item
    ),
    true
  );
});

test("uses an exact broker ID even when trade history fails", async () => {
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return {
        orders: [
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") throw new Error("trade history unavailable");
    if (input.path === "iserver/account/order/status/10") {
      return recoveredTerminalRootStatus("10");
    }
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", orderId: "10" },
    graphTwoNodes()
  );
  assert.equal(result.state, "accepted");
  assert.equal(
    client.calls.some((call) => call.path === "iserver/account/order/status/10"),
    true
  );
});

test("uses a caller-named exact status as attachment evidence when snapshots omit it", async () => {
  const exactStatusWithoutClientOrderId = recoveredTerminalRootStatus("10");
  delete exactStatusWithoutClientOrderId["cOID"];
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return {
        orders: [
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/10") {
      return exactStatusWithoutClientOrderId;
    }
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", orderId: "10" },
    graphTwoNodes()
  );

  assert.equal(result.state, "accepted");
  assert.deepEqual(
    result.members.map(({ memberId, orderId, status }) => [memberId, orderId, status]),
    [
      ["entry", "10", "FILLED"],
      ["stop", "11", "WORKING"],
    ]
  );
});

test("uses a caller-named exact status to identify a child without parent identity", async () => {
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return { orders: [liveRoot()] };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/11") {
      return {
        account: "U1",
        order_id: "11",
        order_status: "Cancelled",
        conid: 1,
        orderType: "STP",
        side: "BUY",
        totalSize: 1,
        stopPrice: 2.4,
        tif: "GTC",
        outsideRTH: false,
      };
    }
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", orderId: "11" },
    graphTwoNodes()
  );

  assert.equal(result.state, "accepted");
  assert.deepEqual(
    result.members.map(({ memberId, orderId, status }) => [memberId, orderId, status]),
    [
      ["entry", "10", "WORKING"],
      ["stop", "11", "CANCELED"],
    ]
  );
});

test("rejects a caller-named status ticket that matches multiple requested nodes", async () => {
  const request = graphTwoNodes();
  const stop = request.nodes[1]!;
  const ambiguousRequest: DerivativeOrderGraphRequest = {
    ...request,
    nodes: [request.nodes[0]!, stop, { ...stop, memberId: "stop-copy" }],
  };
  const attachedStop = {
    account: "U1",
    order_id: "11",
    order_status: "Submitted",
    conid: 1,
    orderType: "STP",
    side: "BUY",
    totalSize: 1,
    stopPrice: 2.4,
    tif: "GTC",
    outsideRTH: false,
    parentId: "pcs-42",
  };
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return { orders: [liveRoot(), attachedStop] };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/12") {
      return { ...attachedStop, order_id: "12", parentId: undefined, order_status: "Cancelled" };
    }
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", orderId: "12" },
    ambiguousRequest
  );
  assert.equal(result.state, "recovery_required");
});

test("rejects caller-named status evidence with a conflicting identity or ticket", async () => {
  for (const conflictingFields of [
    { cOID: "other-graph" },
    { limitPrice: -9.99 },
    { tif: "GTC" },
  ]) {
    const exactStatus = recoveredTerminalRootStatus("10");
    delete exactStatus["cOID"];
    Object.assign(exactStatus, conflictingFields);
    const client = new Fake((input) => {
      if (input.path === "iserver/account/orders") {
        if (input.params?.["filters"] !== undefined) return { orders: [] };
        return {
          orders: [
            {
              account: "U1",
              order_id: "11",
              order_status: "Submitted",
              conid: 1,
              orderType: "STP",
              side: "BUY",
              totalSize: 1,
              stopPrice: 2.4,
              parentId: "pcs-42",
            },
          ],
        };
      }
      if (input.path === "iserver/account/trades") return [];
      if (input.path === "iserver/account/order/status/10") return exactStatus;
      return session(input);
    });

    const result = await client.recoverDerivativeOrderGraph(
      { accountId: "U1", orderId: "10" },
      graphTwoNodes()
    );
    assert.equal(result.state, "recovery_required", JSON.stringify(conflictingFields));
  }
});

test("rejects conflicting listing evidence for a caller-named broker ID", async () => {
  for (const conflictingFields of [{ cOID: "other-graph" }, { limitPrice: -9.99 }]) {
    const exactStatus = recoveredTerminalRootStatus("10");
    delete exactStatus["cOID"];
    const client = new Fake((input) => {
      if (input.path === "iserver/account/orders") {
        if (input.params?.["filters"] !== undefined) return { orders: [] };
        return {
          orders: [
            { ...liveRoot(), ...conflictingFields },
            {
              account: "U1",
              order_id: "11",
              order_status: "Submitted",
              conid: 1,
              orderType: "STP",
              side: "BUY",
              totalSize: 1,
              stopPrice: 2.4,
              parentId: "pcs-42",
            },
          ],
        };
      }
      if (input.path === "iserver/account/trades") return [];
      if (input.path === "iserver/account/order/status/10") return exactStatus;
      return session(input);
    });

    const result = await client.recoverDerivativeOrderGraph(
      { accountId: "U1", orderId: "10" },
      graphTwoNodes()
    );
    assert.equal(result.state, "recovery_required", JSON.stringify(conflictingFields));
  }
});

test("fails closed when a terminal snapshot lookup fails", async () => {
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "filled") throw new Error("filled snapshot unavailable");
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return {
        orders: [
          liveRoot(),
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.equal(
    result.unrecognizedResponses.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as { source?: string }).source === "terminal_order_snapshot"
    ),
    true
  );
});

test("preserves trade-linked terminal attachments when status lookup fails", async () => {
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return {
        orders: [
          liveRoot(),
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
          {
            account: "U1",
            order_id: "12",
            order_status: "Submitted",
            conid: 2,
            orderType: "MKT",
            side: "SELL",
            totalSize: 1,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") {
      return [{ account: "U1", order_ref: "pcs-42", order_id: "13" }];
    }
    if (input.path === "iserver/account/order/status/13") {
      throw new Error("terminal status unavailable");
    }
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graph()
  );
  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.equal(
    result.unrecognizedResponses.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as { order_id?: string }).order_id === "13"
    ),
    true
  );
});

test("fails closed when terminal snapshot and status linkage conflict", async () => {
  const terminalRoot = {
    ...recoveredTerminalRootStatus("10"),
    order_status: "Cancelled",
  };
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "cancelled") return { orders: [terminalRoot] };
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return {
        orders: [
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/10") {
      return { ...terminalRoot, cOID: "different-root" };
    }
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
});

test("fails closed when terminal ticket economics conflict across sources", async () => {
  const terminalRoot = recoveredTerminalRootStatus("10");
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "filled") return { orders: [terminalRoot] };
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return {
        orders: [
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/10") {
      return { ...terminalRoot, limitPrice: -9.99 };
    }
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
});

test("preserves malformed terminal ticket evidence as recovery_required", async () => {
  const malformedTerminalRoot = {
    ...recoveredTerminalRootStatus("10"),
    orderType: 123,
  };
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "filled") return { orders: [malformedTerminalRoot] };
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return {
        orders: [
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/10") return malformedTerminalRoot;
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.equal(result.unrecognizedResponses.length > 0, true);
});

test("requires complete TIF and session fields for terminal matching", async () => {
  const terminalRoot = {
    ...recoveredTerminalRootStatus("10"),
    order_status: "Cancelled",
  } as Record<string, unknown>;
  delete terminalRoot["tif"];
  delete terminalRoot["outsideRTH"];
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "cancelled") return { orders: [terminalRoot] };
      if (input.params?.["filters"] !== undefined) return { orders: [] };
      return {
        orders: [
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
  assert.equal(result.members[0]?.orderId, null);
});

test("retains uniquely matched terminal members in partial recovery evidence", async () => {
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") return { orders: [] };
    if (input.path === "iserver/account/trades") {
      return [{ account: "U1", order_ref: "pcs-42", order_id: "10" }];
    }
    if (input.path === "iserver/account/order/status/10") {
      return recoveredTerminalRootStatus("10");
    }
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
  assert.deepEqual(
    result.members.map(({ memberId, orderId, status }) => [memberId, orderId, status]),
    [
      ["entry", "10", "FILLED"],
      ["stop", null, "WARNING_PENDING"],
    ]
  );
});

test("returns recovery_required when terminal evidence is ambiguous and preserves evidence", async () => {
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") return { orders: [] };
    if (input.path === "iserver/account/trades")
      return [
        { execution_id: "exec-a", account: "U1", order_ref: "pcs-42", order_id: "10", conid: 1 },
        { execution_id: "exec-b", account: "U1", order_ref: "pcs-42", order_id: "11", conid: 1 },
      ];
    if (input.path === "iserver/account/order/status/10") return recoveredTerminalRootStatus("10");
    if (input.path === "iserver/account/order/status/11") return recoveredTerminalRootStatus("11");
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.deepEqual(
    result.members.map(({ orderId }) => orderId),
    [null, null]
  );
  assert.deepEqual(
    result.unrecognizedResponses.map((item) => (item as { order_id: string }).order_id),
    ["10", "11"]
  );
});

test("recovery fails closed for an unexpected order attached to the root", async () => {
  const client = new Fake((input) =>
    input.path === "iserver/account/orders"
      ? {
          orders: [
            liveRoot(),
            {
              account: "U1",
              order_id: "11",
              order_status: "Submitted",
              conid: 1,
              orderType: "STP",
              side: "BUY",
              totalSize: 1,
              stopPrice: 2.4,
              parentId: "pcs-42",
            },
            {
              account: "U1",
              order_id: "12",
              order_status: "Submitted",
              conid: 2,
              orderType: "MKT",
              side: "SELL",
              totalSize: 1,
              parentId: "pcs-42",
            },
            {
              account: "U1",
              order_id: "13",
              order_status: "Submitted",
              conid: 3,
              orderType: "MKT",
              side: "SELL",
              totalSize: 1,
              parentId: "pcs-42",
            },
          ],
        }
      : session(input)
  );

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graph()
  );
  assert.equal(result.state, "recovery_required");
});

test("recovery validates root economics instead of trusting its client order ID", async () => {
  const client = new Fake((input) =>
    input.path === "iserver/account/orders"
      ? {
          orders: [
            { ...liveRoot(), limitPrice: -9.99 },
            {
              account: "U1",
              order_id: "11",
              conid: 1,
              orderType: "STP",
              side: "BUY",
              totalSize: 1,
              stopPrice: 2.4,
              parentId: "pcs-42",
            },
            {
              account: "U1",
              order_id: "12",
              conid: 2,
              orderType: "MKT",
              side: "SELL",
              totalSize: 1,
              parentId: "pcs-42",
            },
          ],
        }
      : session(input)
  );

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graph()
  );
  assert.equal(result.state, "recovery_required");
  assert.equal(result.members[0]?.orderId, null);
});

test("recovery rejects a matching root that is attached to an external parent", async () => {
  const client = new Fake((input) =>
    input.path === "iserver/account/orders"
      ? {
          orders: [
            { ...liveRoot(), parentId: "external-parent" },
            {
              account: "U1",
              order_id: "11",
              conid: 1,
              orderType: "STP",
              side: "BUY",
              totalSize: 1,
              stopPrice: 2.4,
              parentId: "pcs-42",
            },
            {
              account: "U1",
              order_id: "12",
              conid: 2,
              orderType: "MKT",
              side: "SELL",
              totalSize: 1,
              parentId: "pcs-42",
            },
          ],
        }
      : session(input)
  );

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graph()
  );
  assert.equal(result.state, "recovery_required");
  assert.equal(result.members[0]?.orderId, null);
});

test("recovery rejects a single child with mismatched TIF or trading session", async () => {
  for (const schedule of [
    { tif: "DAY", outsideRTH: false },
    { tif: "GTC", outsideRTH: true },
  ]) {
    const client = new Fake((input) =>
      input.path === "iserver/account/orders"
        ? {
            orders: [
              liveRoot(),
              {
                account: "U1",
                order_id: "11",
                conid: 1,
                orderType: "STP",
                side: "BUY",
                totalSize: 1,
                stopPrice: 2.4,
                parentId: "pcs-42",
                ...schedule,
              },
              {
                account: "U1",
                order_id: "12",
                conid: 2,
                orderType: "MKT",
                side: "SELL",
                totalSize: 1,
                parentId: "pcs-42",
              },
            ],
          }
        : session(input)
    );
    const result = await client.recoverDerivativeOrderGraph(
      { accountId: "U1", rootClientOrderId: "pcs-42" },
      graph()
    );
    assert.equal(result.state, "recovery_required");
    assert.equal(result.members[1]?.orderId, null);
  }
});

test("rejects contradictory broker ID aliases in exact terminal status", async () => {
  const terminalRoot = recoveredTerminalRootStatus("10");
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "filled") {
        return { snapshot: true, orders: [terminalRoot] };
      }
      if (input.params?.["filters"] !== undefined) return { snapshot: true, orders: [] };
      return {
        snapshot: true,
        orders: [
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            tif: "GTC",
            outsideRTH: false,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/10") {
      return { ...terminalRoot, orderId: "99" };
    }
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
});

test("fails closed for incomplete active and terminal snapshot markers", async () => {
  for (const incompleteSource of ["active", "missing-active", "filled"] as const) {
    const client = new Fake((input) => {
      if (input.path === "iserver/account/orders") {
        const filter = input.params?.["filters"];
        if (filter !== undefined) {
          return { snapshot: incompleteSource === filter ? false : true, orders: [] };
        }
        return {
          snapshot:
            incompleteSource === "active"
              ? false
              : incompleteSource === "missing-active"
                ? undefined
                : true,
          orders: [
            liveRoot(),
            {
              account: "U1",
              order_id: "11",
              order_status: "Submitted",
              conid: 1,
              orderType: "STP",
              side: "BUY",
              totalSize: 1,
              stopPrice: 2.4,
              tif: "GTC",
              outsideRTH: false,
              parentId: "pcs-42",
            },
          ],
        };
      }
      if (input.path === "iserver/account/trades") return [];
      return session(input);
    });

    const result = await client.recoverDerivativeOrderGraph(
      { accountId: "U1", rootClientOrderId: "pcs-42" },
      graphTwoNodes()
    );
    assert.equal(result.state, "recovery_required", incompleteSource);
  }
});

test("detects unexpected attached descendants in nested terminal collections", async () => {
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "cancelled") {
        return {
          snapshot: true,
          orders: [
            {
              account: "U1",
              order_id: "unrelated",
              cOID: "other-root",
              childOrders: [
                {
                  account: "U1",
                  order_id: "13",
                  order_status: "Cancelled",
                  conid: 3,
                  orderType: "MKT",
                  side: "SELL",
                  totalSize: 1,
                  tif: "DAY",
                  outsideRTH: false,
                  parentId: "pcs-42",
                },
              ],
            },
          ],
        };
      }
      if (input.params?.["filters"] !== undefined) return { snapshot: true, orders: [] };
      return {
        snapshot: true,
        orders: [
          liveRoot(),
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            tif: "GTC",
            outsideRTH: false,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/13") {
      return {
        account: "U1",
        order_id: "13",
        order_status: "Cancelled",
        conid: 3,
        orderType: "MKT",
        side: "SELL",
        totalSize: 1,
        tif: "DAY",
        outsideRTH: false,
        parentId: "pcs-42",
      };
    }
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
});

test("preserves malformed attached trade evidence", async () => {
  const malformedTrade = {
    account: "U1",
    order_ref: "pcs-42",
    order_id: { unexpected: "value" },
  };
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] !== undefined) return { snapshot: true, orders: [] };
      return {
        snapshot: true,
        orders: [
          liveRoot(),
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            tif: "GTC",
            outsideRTH: false,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [malformedTrade];
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.equal(result.unrecognizedResponses.includes(malformedTrade), true);
});

test("preserves conflicts between filtered terminal snapshots", async () => {
  const validRoot = recoveredTerminalRootStatus("10");
  const conflictingRoot = { ...validRoot, limitPrice: -9.99 };
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "filled") {
        return { snapshot: true, orders: [conflictingRoot] };
      }
      if (input.params?.["filters"] === "cancelled") {
        return { snapshot: true, orders: [validRoot] };
      }
      if (input.params?.["filters"] !== undefined) return { snapshot: true, orders: [] };
      return {
        snapshot: true,
        orders: [
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            tif: "GTC",
            outsideRTH: false,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/10") return validRoot;
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
});

test("converts malformed terminal lifecycle status into recovery evidence", async () => {
  const terminalRoot = recoveredTerminalRootStatus("10");
  const malformedStatus = { ...terminalRoot, order_status: { state: "Filled" } };
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] === "filled") {
        return { snapshot: true, orders: [terminalRoot] };
      }
      if (input.params?.["filters"] !== undefined) return { snapshot: true, orders: [] };
      return {
        snapshot: true,
        orders: [
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            tif: "GTC",
            outsideRTH: false,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    if (input.path === "iserver/account/order/status/10") return malformedStatus;
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
  if (result.state !== "recovery_required") return;
  assert.equal(result.unrecognizedResponses.includes(malformedStatus), true);
});

test("rejects contradictory immutable and lifecycle aliases within terminal evidence", async () => {
  for (const conflictingFields of [
    { order_type: "LMT", orderType: "MKT" },
    { order_status: "Filled", status: "Cancelled" },
  ]) {
    const terminalRoot = { ...recoveredTerminalRootStatus("10"), ...conflictingFields };
    const client = new Fake((input) => {
      if (input.path === "iserver/account/orders") {
        if (input.params?.["filters"] === "filled") {
          return { snapshot: true, orders: [terminalRoot] };
        }
        if (input.params?.["filters"] !== undefined) return { snapshot: true, orders: [] };
        return {
          snapshot: true,
          orders: [
            {
              account: "U1",
              order_id: "11",
              order_status: "Submitted",
              conid: 1,
              orderType: "STP",
              side: "BUY",
              totalSize: 1,
              stopPrice: 2.4,
              tif: "GTC",
              outsideRTH: false,
              parentId: "pcs-42",
            },
          ],
        };
      }
      if (input.path === "iserver/account/trades") return [];
      if (input.path === "iserver/account/order/status/10") return terminalRoot;
      return session(input);
    });

    const result = await client.recoverDerivativeOrderGraph(
      { accountId: "U1", rootClientOrderId: "pcs-42" },
      graphTwoNodes()
    );
    assert.equal(result.state, "recovery_required");
  }
});

test("fails closed for an unexpected child nested under an active root", async () => {
  const rootWithUnexpectedChild = {
    ...liveRoot(),
    childOrders: [
      {
        account: "U1",
        order_id: "13",
        order_status: "Submitted",
        conid: 3,
        orderType: "MKT",
        side: "SELL",
        totalSize: 1,
        tif: "DAY",
        outsideRTH: false,
      },
    ],
  };
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      if (input.params?.["filters"] !== undefined) return { snapshot: true, orders: [] };
      return {
        snapshot: true,
        orders: [
          rootWithUnexpectedChild,
          {
            account: "U1",
            order_id: "11",
            order_status: "Submitted",
            conid: 1,
            orderType: "STP",
            side: "BUY",
            totalSize: 1,
            stopPrice: 2.4,
            tif: "GTC",
            outsideRTH: false,
            parentId: "pcs-42",
          },
        ],
      };
    }
    if (input.path === "iserver/account/trades") return [];
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graphTwoNodes()
  );
  assert.equal(result.state, "recovery_required");
});

test("preserves terminal children linked through every parent-client alias", async () => {
  for (const parentAlias of ["parent_order_ref", "parentClientOrderId"] as const) {
    const unexpectedChild = {
      account: "U1",
      order_id: "13",
      order_status: "Cancelled",
      conid: 3,
      orderType: "MKT",
      side: "SELL",
      totalSize: 1,
      tif: "DAY",
      outsideRTH: false,
      [parentAlias]: "pcs-42",
    };
    const client = new Fake((input) => {
      if (input.path === "iserver/account/orders") {
        if (input.params?.["filters"] === "cancelled") {
          return { snapshot: true, orders: [unexpectedChild] };
        }
        if (input.params?.["filters"] !== undefined) return { snapshot: true, orders: [] };
        return {
          snapshot: true,
          orders: [
            liveRoot(),
            {
              account: "U1",
              order_id: "11",
              order_status: "Submitted",
              conid: 1,
              orderType: "STP",
              side: "BUY",
              totalSize: 1,
              stopPrice: 2.4,
              tif: "GTC",
              outsideRTH: false,
              parentId: "pcs-42",
            },
          ],
        };
      }
      if (input.path === "iserver/account/trades") return [];
      if (input.path === "iserver/account/order/status/13") return unexpectedChild;
      return session(input);
    });

    const result = await client.recoverDerivativeOrderGraph(
      { accountId: "U1", rootClientOrderId: "pcs-42" },
      graphTwoNodes()
    );
    assert.equal(result.state, "recovery_required", parentAlias);
    assert.equal(
      client.calls.some((call) => call.path === "iserver/account/order/status/13"),
      true,
      parentAlias
    );
  }
});

test("recovers expected terminal children through every parent-client alias", async () => {
  for (const parentAlias of ["parent_order_ref", "parentClientOrderId"] as const) {
    const terminalStop = {
      account: "U1",
      order_id: "11",
      order_status: "Cancelled",
      conid: 1,
      orderType: "STP",
      side: "BUY",
      totalSize: 1,
      stopPrice: 2.4,
      tif: "GTC",
      outsideRTH: false,
      [parentAlias]: "pcs-42",
    };
    const client = new Fake((input) => {
      if (input.path === "iserver/account/orders") {
        if (input.params?.["filters"] === "cancelled") {
          return { snapshot: true, orders: [terminalStop] };
        }
        if (input.params?.["filters"] !== undefined) return { snapshot: true, orders: [] };
        return { snapshot: true, orders: [liveRoot()] };
      }
      if (input.path === "iserver/account/trades") return [];
      if (input.path === "iserver/account/order/status/11") return terminalStop;
      return session(input);
    });

    const result = await client.recoverDerivativeOrderGraph(
      { accountId: "U1", rootClientOrderId: "pcs-42" },
      graphTwoNodes()
    );
    assert.equal(result.state, "accepted", parentAlias);
    if (result.state !== "accepted") continue;
    assert.equal(result.members[1]?.orderId, "11", parentAlias);
    assert.equal(result.members[1]?.status, "CANCELED", parentAlias);
  }
});

/**
 * Every field spelling below is copied from a real IBKR paper account (2026-08-06), where a
 * filled BAG entry with an armed BAG STOP child could not be recovered at all: the snapshot
 * reports a DAY order as `timeInForce: "CLOSE"`, echoes the child's `parentId` as the parent's
 * numeric broker order ID, spells the stop price `stop_price` next to an empty `price`, and the
 * exact status read reports `size` as the remaining quantity with no client order ID at all.
 */
const liveComboSnapshot = (): Record<string, unknown>[] => [
  {
    acct: "U1",
    account: "U1",
    orderId: 980150331,
    order_ref: "pcs-42",
    conidex: "28812380;;;1/-1,2/1",
    conid: 28812380,
    secType: "BAG",
    side: "BUY",
    totalSize: 1,
    filledQuantity: 1,
    remainingQuantity: 0,
    sizeAndFills: "1",
    status: "Filled",
    orderType: "Limit",
    origOrderType: "LIMIT",
    price: "-1.2",
    avgPrice: "-1.20000005",
    timeInForce: "CLOSE",
  },
  {
    acct: "U1",
    account: "U1",
    orderId: 980150332,
    order_ref: "pcs-42:stop",
    parentId: 980150331,
    conidex: "28812380;;;1/1,2/-1",
    conid: 28812380,
    secType: "BAG",
    side: "BUY",
    totalSize: 1,
    filledQuantity: 0,
    remainingQuantity: 1,
    sizeAndFills: "0/1",
    status: "PreSubmitted",
    orderType: "Stop",
    origOrderType: "STOP",
    price: "",
    stop_price: "2.40",
    auxPrice: "2.40",
    timeInForce: "GTC",
  },
];
const liveComboStatus = (): Record<string, unknown> => ({
  account: "U1",
  order_id: 980150331,
  conidex: "28812380;;;1/-1,2/1",
  conid: 28812380,
  sec_type: "BAG",
  side: "B",
  order_type: "LIMIT",
  limit_price: "-1.2",
  size: "0.0",
  total_size: "1.0",
  cum_fill: "1.0",
  size_and_fills: "1",
  order_status: "Filled",
  tif: "DAY",
});

test("recovers a filled combo entry and its armed combo STOP from real IBKR field spellings", async () => {
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      return input.params?.["filters"] === "filled"
        ? { orders: [liveComboSnapshot()[0]] }
        : input.params?.["filters"] === undefined
          ? { orders: liveComboSnapshot() }
          : { orders: [] };
    }
    if (input.path === "iserver/account/order/status/980150331") return liveComboStatus();
    if (input.path === "iserver/account/trades") return [];
    return session(input);
  });
  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", orderId: "980150331" },
    comboStopGraph()
  );
  assert.equal(result.state, "accepted");
  assert.deepEqual(
    result.members.map(({ memberId, orderId, status, parentOrderId }) => [
      memberId,
      orderId,
      status,
      parentOrderId,
    ]),
    [
      ["entry", "980150331", "FILLED", null],
      ["stop", "980150332", "WORKING", "980150331"],
    ]
  );
});

test("graph recovery still fails closed when a parent order ID names no member of the graph", async () => {
  const client = new Fake((input) => {
    if (input.path === "iserver/account/orders") {
      const [entry, stop] = liveComboSnapshot();
      return input.params?.["filters"] === undefined
        ? { orders: [entry, { ...stop, parentId: 555000111 }] }
        : { orders: [] };
    }
    if (input.path === "iserver/account/trades") return [];
    return session(input);
  });
  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    comboStopGraph()
  );
  assert.equal(result.state, "recovery_required");
});
