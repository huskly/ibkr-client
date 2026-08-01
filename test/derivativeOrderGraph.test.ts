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
const recoveredTerminalOrderStatus = (): Record<string, unknown> => ({
  account: "U1",
  orderId: "12",
  order_id: "12",
  parentId: "pcs-42",
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
          { order_id: "10", order_status: "Submitted" },
          { order_id: "11", order_status: "Submitted" },
          { order_id: "12", order_status: "Submitted" },
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
  assert.equal("cOID" in data.orders[1]!, false);
  assert.equal(data.orders[2]?.["parentId"], "pcs-42");
  assert.equal("cOID" in data.orders[2]!, false);
  assert.equal(data.orders[2]?.["orderType"], "MKT");
  assert.equal("price" in data.orders[2]!, false);
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
            { order_id: "10", order_status: "Submitted" },
            { order_id: "11", order_status: "Submitted" },
            { order_id: "12", order_status: "Submitted" },
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
      result.unrecognizedResponses.map((item) => (item as { orderId: string }).orderId),
      response.map((item) => item.order_id)
    );
  }
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

test("rejects descendants that IBKR cannot attach to an unidentified child", async () => {
  const invalid = graph();
  invalid.nodes[2]!.parentMemberId = "stop";
  const client = new Fake(() => {
    throw new Error("broker access must not occur");
  });
  await assert.rejects(
    () => client.submitDerivativeOrderGraph(invalid),
    /only root-to-child attachments/
  );
  assert.equal(client.calls.length, 0);
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
          order_ref: "pcs-42",
          order_id: "12",
          conid: 2,
          size: 1,
        },
      ];
    if (input.path === "iserver/account/order/status/12") return recoveredTerminalOrderStatus();
    return session(input);
  });

  const result = await client.recoverDerivativeOrderGraph(
    { accountId: "U1", rootClientOrderId: "pcs-42" },
    graph()
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
