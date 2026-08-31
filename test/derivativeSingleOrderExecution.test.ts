import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient, IbkrHttpError } from "../src/ibkr/ibkrClient.js";
import type {
  DerivativeContingentChildOrderRequest,
  DerivativeContingentParentOrderRequest,
  DerivativeContract,
  DerivativeSingleOrderRequest,
} from "../src/types.js";
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

function contract(
  conid: number,
  strike: number,
  assetClass: DerivativeContract["assetClass"] = "OPT"
): DerivativeContract {
  return {
    conid,
    assetClass,
    underlying: assetClass === "OPT" ? "SPY" : "NQ",
    expiration: "2026-08-21",
    strike,
    right: "C",
    tradingClass: assetClass === "OPT" ? "SPY" : "QN3",
    exchange: assetClass === "OPT" ? "SMART" : "CME",
    multiplier: 100,
  };
}

function sessionResponse(input: RequestInput): unknown {
  if (input.path === "iserver/auth/status")
    return { authenticated: true, connected: true, competing: false };
  if (input.path === "iserver/accounts") {
    return { accounts: ["U123"], selectedAccount: "U123", isPaper: true };
  }
  throw new Error(`Unexpected request ${input.path}`);
}

type SingleOrderOverrides = Partial<{
  accountId: string;
  contract: DerivativeContract;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: "LMT" | "STP";
  limit: number;
  stopPrice: number;
  tif: "DAY" | "GTC";
  session: "REGULAR" | "OVERNIGHT";
  clientOrderId: string;
  parentId: string;
  extOperator: string;
  manualIndicator: boolean;
}>;

function singleOrderRequest(overrides: SingleOrderOverrides = {}): DerivativeSingleOrderRequest {
  return {
    accountId: "U123",
    contract: contract(12345, 620, "OPT"),
    side: "BUY",
    quantity: 1,
    orderType: "LMT",
    limit: 2.5,
    tif: "GTC",
    session: "REGULAR",
    clientOrderId: "huskly-cc-entry",
    ...overrides,
  } as DerivativeSingleOrderRequest;
}

function contingentParent(
  request: DerivativeSingleOrderRequest
): DerivativeContingentParentOrderRequest {
  if (request.clientOrderId === undefined) throw new Error("test parent requires clientOrderId");
  const { parentId: _parentId, ...parent } = request;
  return parent as DerivativeContingentParentOrderRequest;
}

function contingentChild(
  request: DerivativeSingleOrderRequest
): DerivativeContingentChildOrderRequest {
  const { clientOrderId: _clientOrderId, parentId: _parentId, ...child } = request;
  return child;
}

void test("single-leg LIMIT BUY order places a covered-call entry", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ order_id: "777", order_status: "PreSubmitted" }];
    }
    return sessionResponse(input);
  });

  const result = await client.submitDerivativeSingleOrder(singleOrderRequest());
  assert.equal(result.state, "accepted");
  if (result.state === "accepted") {
    assert.equal(result.orderId, "777");
    assert.equal(result.clientOrderId, "huskly-cc-entry");
  }
  const placement = client.calls.find(({ path }) => path === "iserver/account/U123/orders");
  assert.deepEqual(placement?.data, {
    orders: [
      {
        acctId: "U123",
        conid: 12345,
        orderType: "LMT",
        side: "BUY",
        price: 2.5,
        tif: "GTC",
        quantity: 1,
        outsideRTH: false,
        cOID: "huskly-cc-entry",
      },
    ],
  });
  assert.equal(client.calls.filter(({ path }) => path === "iserver/account/U123/orders").length, 1);
});

void test("single-leg LIMIT SELL order places a buy-to-close covered-call", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ order_id: "888", order_status: "PreSubmitted" }];
    }
    return sessionResponse(input);
  });

  const result = await client.submitDerivativeSingleOrder(
    singleOrderRequest({ side: "SELL", clientOrderId: "huskly-cc-close" })
  );
  assert.equal(result.state, "accepted");
  if (result.state === "accepted") {
    assert.equal(result.orderId, "888");
  }
  const placement = client.calls.find(({ path }) => path === "iserver/account/U123/orders");
  const ticket = (placement?.data as { orders?: Record<string, unknown>[] } | undefined)
    ?.orders?.[0];
  assert.ok(ticket);
  assert.equal(ticket["side"], "SELL");
  assert.equal(ticket["cOID"], "huskly-cc-close");
});

void test("STOP order rejects without a stop price", async () => {
  const client = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });

  const request = singleOrderRequest({ orderType: "STP" });
  delete (request as Record<string, unknown>)["stopPrice"];

  await assert.rejects(
    () => client.submitDerivativeSingleOrder(request),
    /STOP order requires a positive stop price/
  );
  assert.equal(client.calls.length, 0);
});

void test("STOP order places a GTC stop with stop price", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ order_id: "999", order_status: "PreSubmitted" }];
    }
    return sessionResponse(input);
  });

  const request = singleOrderRequest({
    orderType: "STP",
    stopPrice: 1.5,
    side: "SELL",
    clientOrderId: "huskly-stop",
  });
  delete (request as Record<string, unknown>)["limit"];

  const result = await client.submitDerivativeSingleOrder(request);
  assert.equal(result.state, "accepted");
  const placement = client.calls.find(({ path }) => path === "iserver/account/U123/orders");
  const ticket = (placement?.data as { orders?: Record<string, unknown>[] } | undefined)
    ?.orders?.[0];
  assert.ok(ticket);
  assert.equal(ticket["orderType"], "STP");
  assert.equal(ticket["price"], 1.5);
  assert.equal("stopPrice" in (ticket as Record<string, unknown>), false);
  assert.equal(ticket["tif"], "GTC");
});

void test("equity-option single order omits CME operator metadata", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ order_id: "777", order_status: "PreSubmitted" }];
    }
    return sessionResponse(input);
  });

  await client.submitDerivativeSingleOrder(singleOrderRequest());
  const placement = client.calls.find(({ path }) => path === "iserver/account/U123/orders");
  const ticket = (placement?.data as { orders?: Record<string, unknown>[] } | undefined)
    ?.orders?.[0];
  assert.ok(ticket);
  assert.equal("extOperator" in (ticket as Record<string, unknown>), false);
  assert.equal("manualIndicator" in (ticket as Record<string, unknown>), false);
});

void test("single order rejects without client order ID", async () => {
  const client = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });

  await assert.rejects(
    () => client.submitDerivativeSingleOrder(singleOrderRequest({ clientOrderId: "" })),
    /Client order ID must contain 1 to 64 characters/
  );
  assert.equal(client.calls.length, 0);
});

void test("single order rejects invalid quantity", async () => {
  const client = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });

  await assert.rejects(
    () => client.submitDerivativeSingleOrder(singleOrderRequest({ quantity: 0 })),
    /Order quantity must be a positive integer/
  );
  assert.equal(client.calls.length, 0);
});

void test("LIMIT order rejects without a limit price", async () => {
  const client = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });

  const request = singleOrderRequest({ orderType: "LMT" });
  delete (request as Record<string, unknown>)["limit"];

  await assert.rejects(
    () => client.submitDerivativeSingleOrder(request),
    /LIMIT order requires a positive limit price/
  );
  assert.equal(client.calls.length, 0);
});

void test("contingent parent-child orders submit both in one request", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: "888", order_status: "PreSubmitted" },
      ];
    }
    return sessionResponse(input);
  });

  const parent = singleOrderRequest({
    side: "SELL",
    limit: 2.5,
    clientOrderId: "huskly-parent",
  });

  const child = singleOrderRequest({
    contract: contract(67890, 619, "OPT"),
    side: "BUY",
    orderType: "STP",
    stopPrice: 1.5,
    clientOrderId: "huskly-child",
    parentId: "huskly-parent",
  });
  delete (child as Record<string, unknown>)["limit"];

  const result = await client.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });

  assert.equal(result.state, "accepted");
  if (result.state === "accepted") {
    assert.equal(result.orders.length, 2);
    assert.equal(result.orders[0]?.orderId, "777");
    assert.equal(result.orders[1]?.orderId, "888");
  }

  const placement = client.calls.find(({ path }) => path === "iserver/account/U123/orders");
  const orders = (placement?.data as { orders?: Record<string, unknown>[] } | undefined)?.orders;
  assert.ok(orders);
  assert.equal(orders.length, 2);
  assert.equal(orders[0]?.["cOID"], "huskly-parent");
  assert.equal(orders[0]?.["orderType"], "LMT");
  assert.equal("cOID" in (orders[1] as Record<string, unknown>), false);
  assert.equal(orders[1]?.["parentId"], "huskly-parent");
  assert.equal(orders[1]?.["orderType"], "STP");
  assert.equal(orders[1]?.["price"], 1.5);
  assert.equal("stopPrice" in (orders[1] as Record<string, unknown>), false);
  assert.equal(client.calls.filter(({ path }) => path === "iserver/account/U123/orders").length, 1);
});

void test("contingent orders reject mismatched accounts", async () => {
  const client = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });

  const parent = singleOrderRequest({ accountId: "U123" });
  const child = singleOrderRequest({ accountId: "U999", contract: contract(99999, 100, "OPT") });

  await assert.rejects(
    () =>
      client.submitDerivativeContingentOrders({
        accountId: "U123",
        parent: contingentParent(parent),
        child: contingentChild(child),
      }),
    /Contingent parent and child orders must target the exact same account/
  );
  assert.equal(client.calls.length, 0);
});

void test("contingent orders support documented same-contract brackets", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: "888", order_status: "PreSubmitted" },
      ];
    }
    return sessionResponse(input);
  });

  const parent = singleOrderRequest({ clientOrderId: "parent" });
  const child = singleOrderRequest({
    clientOrderId: "child",
    contract: contract(12345, 620, "OPT"),
    parentId: "parent",
  });

  const result = await client.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });
  assert.equal(result.state, "accepted");
});

void test("single order accepted, warning, and rejected outcomes", async () => {
  for (const fixture of [
    {
      name: "accepted",
      response: [{ order_id: "777", order_status: "Filled" }],
      expected: { state: "accepted", orderId: "777" },
    },
    {
      name: "warning",
      response: [{ id: "warn-1", message: ["Warning"], messageIds: ["o163"] }],
      expected: { state: "warning" },
    },
    {
      name: "rejected",
      response: { error: "Bad order", statusCode: 400 },
      expected: { state: "rejected" },
    },
  ]) {
    const client = new FakeIbkrClient((input) => {
      if (input.path === "iserver/account/U123/orders") return fixture.response;
      return sessionResponse(input);
    });

    const result = await client.submitDerivativeSingleOrder(
      singleOrderRequest({ clientOrderId: `test-${fixture.name}` })
    );
    assert.equal(result.state, fixture.expected.state, `for ${fixture.name}`);
    if (result.state === "accepted" && fixture.expected.state === "accepted") {
      assert.equal(result.orderId, fixture.expected.orderId);
    }
  }
});

void test("blank and invalid broker order IDs require recovery", async () => {
  for (const orderId of ["", "   ", 0, -1, Number.NaN]) {
    const client = new FakeIbkrClient((input) => {
      if (input.path === "iserver/account/U123/orders") {
        return [{ order_id: orderId, order_status: "PreSubmitted" }];
      }
      return sessionResponse(input);
    });

    const result = await client.submitDerivativeSingleOrder(singleOrderRequest());
    assert.equal(result.state, "recovery_required", `for ${String(orderId)}`);
    if (result.state === "recovery_required") {
      assert.equal(result.orders.length, 0);
      assert.deepEqual(result.unrecognizedResponses, [
        { order_id: orderId, order_status: "PreSubmitted" },
      ]);
    }
  }

  const contingent = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: " ", order_status: "PreSubmitted" },
      ];
    }
    return sessionResponse(input);
  });
  const parent = singleOrderRequest({ clientOrderId: "parent-blank-id" });
  const child = singleOrderRequest({
    contract: contract(99999, 100, "OPT"),
    orderType: "STP",
    stopPrice: 1.5,
    parentId: "parent-blank-id",
  });
  delete (child as Record<string, unknown>)["limit"];
  delete (child as Record<string, unknown>)["clientOrderId"];

  const contingentResult = await contingent.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });
  assert.equal(contingentResult.state, "recovery_required");
});

void test("malformed warning message IDs are never classified as known", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ id: "warn-malformed", message: ["Warning"], messageIds: ["o163", 999] }];
    }
    return sessionResponse(input);
  });

  const result = await client.submitDerivativeSingleOrder(singleOrderRequest());
  assert.equal(result.state, "warning");
  if (result.state === "warning") {
    assert.equal(result.warnings[0]?.known, false);
    assert.deepEqual(result.warnings[0]?.messageIds, ["o163"]);
  }
});

void test("blank broker warning IDs require recovery", async () => {
  for (const replyId of ["", "   "]) {
    const client = new FakeIbkrClient((input) => {
      if (input.path === "iserver/account/U123/orders") {
        return [{ id: replyId, message: ["Warning"], messageIds: ["o163"] }];
      }
      return sessionResponse(input);
    });

    const result = await client.submitDerivativeSingleOrder(singleOrderRequest());
    assert.equal(result.state, "recovery_required");
    if (result.state === "recovery_required") {
      assert.equal(result.warnings.length, 0);
      assert.deepEqual(result.unrecognizedResponses, [
        { id: replyId, message: ["Warning"], messageIds: ["o163"] },
      ]);
    }
  }
});

void test("placement transport errors are never retried for single orders", async () => {
  const transportError = Object.assign(new Error("broker unavailable"), { status: 503 });
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") throw transportError;
    return sessionResponse(input);
  });

  await assert.rejects(
    () => client.submitDerivativeSingleOrder(singleOrderRequest()),
    (error) => {
      assert.ok(error instanceof IbkrHttpError);
      assert.equal(error.status, 503);
      assert.equal(error.response.body, "");
      assert.equal(error.cause, transportError);
      return true;
    }
  );
  assert.equal(client.calls.filter(({ path }) => path === "iserver/account/U123/orders").length, 1);
});

void test("contingent order warning and rejection outcomes", async () => {
  for (const fixture of [
    {
      name: "both accepted",
      response: [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: "888", order_status: "PreSubmitted" },
      ],
      expected: { state: "accepted", orderCount: 2 },
    },
    {
      name: "warning",
      response: [{ id: "warn-1", message: ["Warning"], messageIds: ["o163"] }],
      expected: { state: "warning" },
    },
    {
      name: "rejected",
      response: { error: "Bad order", statusCode: 400 },
      expected: { state: "rejected" },
    },
  ]) {
    const client = new FakeIbkrClient((input) => {
      if (input.path === "iserver/account/U123/orders") return fixture.response;
      return sessionResponse(input);
    });

    const parent = singleOrderRequest({
      clientOrderId: `parent-${fixture.name}`,
    });
    const childReq = singleOrderRequest({
      clientOrderId: `child-${fixture.name}`,
      contract: contract(99999, 100, "OPT"),
      orderType: "STP",
      stopPrice: 1.5,
      parentId: `parent-${fixture.name}`,
    });
    delete (childReq as Record<string, unknown>)["limit"];

    const result = await client.submitDerivativeContingentOrders({
      accountId: "U123",
      parent: contingentParent(parent),
      child: contingentChild(childReq),
    });
    assert.equal(result.state, fixture.expected.state, `for ${fixture.name}`);
    if (result.state === "accepted" && fixture.expected.state === "accepted") {
      assert.equal(result.orders.length, fixture.expected.orderCount);
      assert.equal(result.orders[0]?.clientOrderId, `parent-${fixture.name}`);
      assert.equal(result.orders[1]?.clientOrderId, null);
    }
    if (result.state === "warning" && fixture.expected.state === "warning") {
      assert.deepEqual(result.continuation, {
        replyId: "warn-1",
        parentClientOrderId: "parent-warning",
      });
    }
  }
});

void test("array-contained contingent rejection evidence requires recovery", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ error: "Child rejected", statusCode: 400 }];
    }
    return sessionResponse(input);
  });
  const parent = singleOrderRequest({ clientOrderId: "parent-partial-rejection" });
  const child = singleOrderRequest({
    contract: contract(99999, 100, "OPT"),
    orderType: "STP",
    stopPrice: 1.5,
    parentId: "parent-partial-rejection",
  });
  delete (child as Record<string, unknown>)["limit"];
  delete (child as Record<string, unknown>)["clientOrderId"];

  const result = await client.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });

  assert.equal(result.state, "recovery_required");
  if (result.state === "recovery_required") {
    assert.equal(result.errors[0]?.message, "Child rejected");
    assert.equal(result.reasons[0], "Child rejected");
  }
});

void test("non-diagnostic broker error fields require recovery", async () => {
  for (const error of ["", "   ", false, {}]) {
    const client = new FakeIbkrClient((input) => {
      if (input.path === "iserver/account/U123/orders") return { error };
      return sessionResponse(input);
    });

    const result = await client.submitDerivativeSingleOrder(singleOrderRequest());
    assert.equal(result.state, "recovery_required");
    if (result.state === "recovery_required") {
      assert.equal(result.errors.length, 0);
      assert.deepEqual(result.unrecognizedResponses, [{ error }]);
    }
  }
});

void test("contingent orders support general LIMIT and STOP parent-child roles", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: "888", order_status: "PreSubmitted" },
      ];
    }
    return sessionResponse(input);
  });

  const parent = singleOrderRequest({
    clientOrderId: "bad-parent",
    orderType: "STP",
    stopPrice: 1.5,
  });
  delete (parent as Record<string, unknown>)["limit"];
  const child = singleOrderRequest({
    clientOrderId: "child",
    contract: contract(99999, 100, "OPT"),
    orderType: "LMT",
    limit: 2.5,
    parentId: "bad-parent",
  });

  const result = await client.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });
  assert.equal(result.state, "accepted");
});

void test("contingent result rejects when only one order is recognized", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ order_id: "777", order_status: "PreSubmitted" }];
    }
    return sessionResponse(input);
  });

  const parent = singleOrderRequest({ clientOrderId: "parent-only" });
  const child = singleOrderRequest({
    clientOrderId: "child-missing",
    contract: contract(99999, 100, "OPT"),
    orderType: "STP",
    stopPrice: 1.5,
    parentId: "parent-only",
  });
  delete (child as Record<string, unknown>)["limit"];

  const result = await client.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });
  assert.equal(result.state, "recovery_required");
  if (result.state === "recovery_required") {
    assert.equal(result.orders.length, 1);
    assert.equal(result.orders[0]?.orderId, "777");
  }
});

void test("single order forwards parentId when provided", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ order_id: "777", order_status: "PreSubmitted" }];
    }
    return sessionResponse(input);
  });

  const request = singleOrderRequest({
    clientOrderId: "child-order",
    side: "SELL",
    orderType: "STP",
    stopPrice: 1.5,
    parentId: "parent-order",
  });
  delete (request as Record<string, unknown>)["limit"];
  delete (request as Record<string, unknown>)["clientOrderId"];

  await client.submitDerivativeSingleOrder(request);
  const placement = client.calls.find(({ path }) => path === "iserver/account/U123/orders");
  const ticket = (placement?.data as { orders?: Record<string, unknown>[] } | undefined)
    ?.orders?.[0];
  assert.ok(ticket);
  assert.equal(ticket["parentId"], "parent-order");
  assert.equal("cOID" in (ticket as Record<string, unknown>), false);
});

void test("acknowledgeContingentOrderWarning returns multi-order result", async () => {
  const responses = [
    [
      { order_id: "777", order_status: "PreSubmitted" },
      { order_id: "888", order_status: "PreSubmitted" },
    ],
  ];
  const client = new FakeIbkrClient((input) => {
    if (input.path.startsWith("iserver/reply/")) return responses.shift();
    throw new Error(`Unexpected request ${input.path}`);
  });

  const result = await client.acknowledgeContingentOrderWarning({
    continuation: { replyId: "cont-reply", parentClientOrderId: "parent-ack" },
    confirmed: true,
  });
  assert.equal(result.state, "accepted");
  if (result.state === "accepted") {
    assert.equal(result.orders.length, 2);
    assert.equal(result.orders[0]?.orderId, "777");
    assert.equal(result.orders[0]?.clientOrderId, "parent-ack");
    assert.equal(result.orders[1]?.orderId, "888");
    assert.equal(result.orders[1]?.clientOrderId, null);
  }
  assert.equal(client.calls.filter(({ path }) => path.startsWith("iserver/reply/")).length, 1);
});

void test("acknowledgeContingentOrderWarning rejects when only one order recognized", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path.startsWith("iserver/reply/"))
      return [{ order_id: "777", order_status: "PreSubmitted" }];
    throw new Error(`Unexpected request ${input.path}`);
  });

  const result = await client.acknowledgeContingentOrderWarning({
    continuation: { replyId: "partial", parentClientOrderId: "parent-partial" },
    confirmed: true,
  });
  assert.equal(result.state, "recovery_required");
});

void test("contingent result rejects when an order status is REJECTED", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: "888", order_status: "Rejected", text: "Child order was rejected" },
      ];
    }
    return sessionResponse(input);
  });

  const parent = singleOrderRequest({ clientOrderId: "parent-rej" });
  const child = singleOrderRequest({
    clientOrderId: "child-rej",
    contract: contract(99999, 100, "OPT"),
    orderType: "STP",
    stopPrice: 1.5,
    parentId: "parent-rej",
  });
  delete (child as Record<string, unknown>)["limit"];

  const result = await client.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });
  assert.equal(result.state, "recovery_required");
  if (result.state === "recovery_required") {
    assert.deepEqual(
      result.orders.map(({ orderId, role }) => [orderId, role]),
      [
        ["777", "parent"],
        ["888", "child"],
      ]
    );
    assert.equal(result.errors[0]?.message, "Child order was rejected");
    assert.deepEqual(result.unrecognizedResponses, []);
  }
});

void test("contingent result rejects when response has extra unrecognized items", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: "888", order_status: "PreSubmitted" },
        { someNewField: "unexpected" },
      ];
    }
    return sessionResponse(input);
  });

  const parent = singleOrderRequest({ clientOrderId: "parent-extra" });
  const child = singleOrderRequest({
    clientOrderId: "child-extra",
    contract: contract(99999, 100, "OPT"),
    orderType: "STP",
    stopPrice: 1.5,
    parentId: "parent-extra",
  });
  delete (child as Record<string, unknown>)["limit"];

  const result = await client.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });
  assert.equal(result.state, "recovery_required");
});

void test("single order rejects a broker ID with a failed status", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ order_id: "777", order_status: "Inactive" }];
    }
    return sessionResponse(input);
  });

  const result = await client.submitDerivativeSingleOrder(singleOrderRequest());
  assert.equal(result.state, "rejected");
  if (result.state === "rejected") {
    assert.equal(result.orders?.[0]?.orderId, "777");
    assert.equal(result.orders?.[0]?.status, "REJECTED");
  }
});

void test("single order leaves client identity unknown for multiple acknowledgements", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: "888", order_status: "PreSubmitted" },
      ];
    }
    return sessionResponse(input);
  });

  const result = await client.submitDerivativeSingleOrder(singleOrderRequest());
  assert.equal(result.state, "recovery_required");
  if (result.state === "recovery_required") {
    assert.deepEqual(
      result.orders.map(({ clientOrderId }) => clientOrderId),
      [null, null]
    );
  }
});

void test("single order rejects malformed JavaScript identity fields before broker access", async () => {
  for (const request of [
    { ...singleOrderRequest(), parentId: 123 },
    { ...singleOrderRequest(), clientOrderId: 123, parentId: "parent-order" },
  ]) {
    const client = new FakeIbkrClient(() => {
      throw new Error("broker must not be called");
    });
    await assert.rejects(
      () => client.submitDerivativeSingleOrder(request as unknown as DerivativeSingleOrderRequest),
      /order ID must be a string/
    );
    assert.equal(client.calls.length, 0);
  }
});

void test("single order rejects unsupported JavaScript order types before broker access", async () => {
  const client = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });

  await assert.rejects(
    () =>
      client.submitDerivativeSingleOrder({
        ...singleOrderRequest(),
        orderType: "MKT",
      } as unknown as DerivativeSingleOrderRequest),
    /Order type must be LMT or STP/
  );
  assert.equal(client.calls.length, 0);
});

void test("contingent acknowledgement rejects false confirmation before broker access", async () => {
  const client = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });

  await assert.rejects(
    () =>
      client.acknowledgeContingentOrderWarning({
        continuation: { replyId: "declined", parentClientOrderId: "parent-declined" },
        confirmed: false,
      } as unknown as Parameters<IbkrClient["acknowledgeContingentOrderWarning"]>[0]),
    /Order warning confirmation must be true/
  );
  assert.equal(client.calls.length, 0);
});

void test("contingent result requires recovery for duplicate broker order IDs", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: "777", order_status: "PreSubmitted" },
      ];
    }
    return sessionResponse(input);
  });
  const parent = singleOrderRequest({ clientOrderId: "parent-duplicate" });
  const child = singleOrderRequest({
    contract: contract(99999, 100, "OPT"),
    orderType: "STP",
    stopPrice: 1.5,
    parentId: "parent-duplicate",
  });
  delete (child as Record<string, unknown>)["limit"];
  delete (child as Record<string, unknown>)["clientOrderId"];

  const result = await client.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });

  assert.equal(result.state, "recovery_required");
  if (result.state === "recovery_required") {
    assert.match(result.reasons[0] ?? "", /duplicate broker order IDs/);
    assert.deepEqual(
      result.orders.map(({ clientOrderId, role }) => ({ clientOrderId, role })),
      [
        { clientOrderId: null, role: "unknown" },
        { clientOrderId: null, role: "unknown" },
      ]
    );
  }
});

void test("malformed primitive broker replies retain recovery evidence", async () => {
  const single = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") return null;
    return sessionResponse(input);
  });
  const singleResult = await single.submitDerivativeSingleOrder(singleOrderRequest());
  assert.equal(singleResult.state, "recovery_required");
  if (singleResult.state === "recovery_required") {
    assert.deepEqual(singleResult.unrecognizedResponses, [null]);
  }

  const contingent = new FakeIbkrClient((input) => {
    if (input.path.startsWith("iserver/reply/")) return "malformed-reply";
    throw new Error(`Unexpected request ${input.path}`);
  });
  const contingentResult = await contingent.acknowledgeContingentOrderWarning({
    continuation: { replyId: "malformed", parentClientOrderId: "parent-malformed" },
    confirmed: true,
  });
  assert.equal(contingentResult.state, "recovery_required");
  if (contingentResult.state === "recovery_required") {
    assert.deepEqual(contingentResult.unrecognizedResponses, ["malformed-reply"]);
  }
});

void test("contingent result requires recovery when an order is canceled", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: "888", order_status: "Cancelled" },
      ];
    }
    return sessionResponse(input);
  });

  const parent = singleOrderRequest({ clientOrderId: "parent-canceled" });
  const child = singleOrderRequest({
    clientOrderId: "child-canceled",
    contract: contract(99999, 100, "OPT"),
    orderType: "STP",
    stopPrice: 1.5,
    parentId: "parent-canceled",
  });
  delete (child as Record<string, unknown>)["limit"];

  const result = await client.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });
  assert.equal(result.state, "recovery_required");
  if (result.state === "recovery_required") {
    assert.equal(result.orders[1]?.status, "CANCELED");
  }
});

void test("pending cancellation acknowledgements require recovery", async () => {
  const single = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ order_id: "777", order_status: "PendingCancel" }];
    }
    return sessionResponse(input);
  });
  const singleResult = await single.submitDerivativeSingleOrder(singleOrderRequest());
  assert.equal(singleResult.state, "recovery_required");
  if (singleResult.state === "recovery_required") {
    assert.match(singleResult.reasons[0] ?? "", /pending cancellation/);
  }

  const contingent = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: "888", order_status: "PendingCancel" },
      ];
    }
    return sessionResponse(input);
  });
  const parent = singleOrderRequest({ clientOrderId: "parent-pending-cancel" });
  const child = singleOrderRequest({
    contract: contract(99999, 100, "OPT"),
    orderType: "STP",
    stopPrice: 1.5,
    parentId: "parent-pending-cancel",
  });
  delete (child as Record<string, unknown>)["limit"];
  delete (child as Record<string, unknown>)["clientOrderId"];

  const contingentResult = await contingent.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });
  assert.equal(contingentResult.state, "recovery_required");
  if (contingentResult.state === "recovery_required") {
    assert.match(contingentResult.reasons[0] ?? "", /Order 888.*pending cancellation/);
  }
});

void test("mixed contingent warning and rejection requires recovery", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { id: "warn-1", message: ["Warning"], messageIds: ["o163"] },
        { error: "Child rejected", statusCode: 400 },
      ];
    }
    return sessionResponse(input);
  });

  const parent = singleOrderRequest({ clientOrderId: "parent-mixed" });
  const child = singleOrderRequest({
    clientOrderId: "child-mixed",
    contract: contract(99999, 100, "OPT"),
    orderType: "STP",
    stopPrice: 1.5,
    parentId: "parent-mixed",
  });
  delete (child as Record<string, unknown>)["limit"];

  const result = await client.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });
  assert.equal(result.state, "recovery_required");
  if (result.state === "recovery_required") {
    assert.equal(result.warnings[0]?.replyId, "warn-1");
    assert.equal(result.errors[0]?.message, "Child rejected");
  }
});

void test("FOP single orders require and forward CME metadata", async () => {
  const missing = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });
  await assert.rejects(
    () =>
      missing.submitDerivativeSingleOrder(
        singleOrderRequest({ contract: contract(12345, 620, "FOP") })
      ),
    /FOP orders require exact CME operator metadata/
  );

  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ order_id: "777", order_status: "PreSubmitted" }];
    }
    return sessionResponse(input);
  });
  await client.submitDerivativeSingleOrder(
    singleOrderRequest({
      contract: contract(12345, 620, "FOP"),
      extOperator: "operator-1",
      manualIndicator: false,
    })
  );
  const placement = client.calls.find(({ path }) => path === "iserver/account/U123/orders");
  const ticket = (placement?.data as { orders?: Record<string, unknown>[] } | undefined)
    ?.orders?.[0];
  assert.equal(ticket?.["extOperator"], "operator-1");
  assert.equal(ticket?.["manualIndicator"], false);
});

void test("FOP contingent orders require and forward CME metadata for both orders", async () => {
  const missing = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });
  const missingParent = singleOrderRequest({
    contract: contract(12345, 620, "FOP"),
    clientOrderId: "fop-parent-missing",
  });
  const validChild = singleOrderRequest({
    contract: contract(67890, 619, "FOP"),
    clientOrderId: "fop-child",
    parentId: "fop-parent-missing",
    orderType: "STP",
    stopPrice: 1.5,
    extOperator: "operator-child",
    manualIndicator: true,
  });
  delete (validChild as Record<string, unknown>)["limit"];
  await assert.rejects(
    () =>
      missing.submitDerivativeContingentOrders({
        accountId: "U123",
        parent: contingentParent(missingParent),
        child: contingentChild(validChild),
      }),
    /FOP orders require exact CME operator metadata/
  );

  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: "888", order_status: "PreSubmitted" },
      ];
    }
    return sessionResponse(input);
  });
  const parent = singleOrderRequest({
    contract: contract(12345, 620, "FOP"),
    clientOrderId: "fop-parent",
    extOperator: "operator-parent",
    manualIndicator: false,
  });
  const child = singleOrderRequest({
    contract: contract(67890, 619, "FOP"),
    clientOrderId: "fop-child",
    parentId: "fop-parent",
    orderType: "STP",
    stopPrice: 1.5,
    extOperator: "operator-child",
    manualIndicator: true,
  });
  delete (child as Record<string, unknown>)["limit"];
  await client.submitDerivativeContingentOrders({
    accountId: "U123",
    parent: contingentParent(parent),
    child: contingentChild(child),
  });
  const placement = client.calls.find(({ path }) => path === "iserver/account/U123/orders");
  const orders = (placement?.data as { orders?: Record<string, unknown>[] } | undefined)?.orders;
  assert.equal(orders?.[0]?.["extOperator"], "operator-parent");
  assert.equal(orders?.[0]?.["manualIndicator"], false);
  assert.equal(orders?.[1]?.["extOperator"], "operator-child");
  assert.equal(orders?.[1]?.["manualIndicator"], true);
});
