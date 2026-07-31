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
    return Promise.resolve(this.response(input) as T);
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
