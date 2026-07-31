import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient } from "../src/ibkr/ibkrClient.js";
import type { DerivativeContract, DerivativeSingleOrderRequest } from "../src/types.js";
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
  if (input.path === "iserver/auth/status") return { authenticated: true, competing: false };
  if (input.path === "iserver/accounts") {
    return { accounts: ["U123"], selectedAccount: "U123", isPaper: true };
  }
  throw new Error(`Unexpected request ${input.path}`);
}

function singleOrderRequest(
  overrides: Partial<DerivativeSingleOrderRequest> = {}
): DerivativeSingleOrderRequest {
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
  };
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
  assert.equal(ticket["stopPrice"], 1.5);
  assert.equal("price" in (ticket as Record<string, unknown>), false);
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
    parent,
    child,
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
  assert.equal(orders[1]?.["cOID"], "huskly-child");
  assert.equal(orders[1]?.["parentId"], "huskly-parent");
  assert.equal(orders[1]?.["orderType"], "STP");
  assert.equal(orders[1]?.["stopPrice"], 1.5);
  assert.equal("price" in (orders[1] as Record<string, unknown>), false);
  assert.equal(client.calls.filter(({ path }) => path === "iserver/account/U123/orders").length, 1);
});

void test("contingent orders reject mismatched accounts", async () => {
  const client = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });

  const parent = singleOrderRequest({ accountId: "U123" });
  const child = singleOrderRequest({ accountId: "U999", contract: contract(99999, 100, "OPT") });

  await assert.rejects(
    () => client.submitDerivativeContingentOrders({ accountId: "U123", parent, child }),
    /Contingent parent and child orders must target the exact same account/
  );
  assert.equal(client.calls.length, 0);
});

void test("contingent orders reject identical client order IDs", async () => {
  const client = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });

  const parent = singleOrderRequest({ clientOrderId: "same-id" });
  const child = singleOrderRequest({
    clientOrderId: "same-id",
    contract: contract(99999, 100, "OPT"),
  });

  await assert.rejects(
    () => client.submitDerivativeContingentOrders({ accountId: "U123", parent, child }),
    /Contingent parent and child orders require distinct client order IDs/
  );
  assert.equal(client.calls.length, 0);
});

void test("contingent orders reject identical contracts", async () => {
  const client = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });

  const parent = singleOrderRequest({ clientOrderId: "parent" });
  const child = singleOrderRequest({
    clientOrderId: "child",
    contract: contract(12345, 620, "OPT"),
    parentId: "parent",
  });

  await assert.rejects(
    () => client.submitDerivativeContingentOrders({ accountId: "U123", parent, child }),
    /Contingent parent and child orders must reference distinct contracts/
  );
  assert.equal(client.calls.length, 0);
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

void test("placement transport errors are never retried for single orders", async () => {
  const transportError = Object.assign(new Error("broker unavailable"), { status: 503 });
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") throw transportError;
    return sessionResponse(input);
  });

  await assert.rejects(
    () => client.submitDerivativeSingleOrder(singleOrderRequest()),
    (error) => {
      assert.equal(error, transportError);
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
    const child = singleOrderRequest({
      clientOrderId: `child-${fixture.name}`,
      contract: contract(99999, 100, "OPT"),
      parentId: `parent-${fixture.name}`,
    });

    const result = await client.submitDerivativeContingentOrders({
      accountId: "U123",
      parent,
      child,
    });
    assert.equal(result.state, fixture.expected.state, `for ${fixture.name}`);
    if (result.state === "accepted" && fixture.expected.state === "accepted") {
      assert.equal(result.orders.length, fixture.expected.orderCount);
    }
  }
});
