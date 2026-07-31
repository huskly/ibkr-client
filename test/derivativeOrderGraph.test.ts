import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient } from "../src/ibkr/ibkrClient.js";
import type { DerivativeContract, DerivativeOrderGraphRequest } from "../src/types.js";
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
      parentMemberId: "stop",
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
      ["grandchild", "12", "11"],
    ]
  );
  assert.equal(result.rootClientOrderId, "pcs-42");
  const data = client.calls.find((c) => c.method === "POST" && c.path.endsWith("/orders"))
    ?.data as { orders: Record<string, unknown>[] };
  assert.equal(data.orders[0]?.["cOID"], "pcs-42");
  assert.equal(data.orders[1]?.["parentId"], "pcs-42");
  assert.equal(data.orders[1]?.["cOID"], "pcs-42:stop");
  assert.equal(data.orders[2]?.["parentId"], "pcs-42:stop");
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
    assert.equal((await client.submitDerivativeOrderGraph(graph())).state, "recovery_required");
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

test("recovers exact graph from root or a known broker identity", async () => {
  const orders = {
    orders: [
      { account: "U1", order_id: "10", order_status: "Submitted", cOID: "pcs-42" },
      {
        account: "U1",
        order_id: "11",
        order_status: "Submitted",
        cOID: "pcs-42:stop",
        parentId: "pcs-42",
      },
      {
        account: "U1",
        order_id: "12",
        order_status: "Submitted",
        cOID: "pcs-42:hedge",
        parentId: "pcs-42:stop",
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
