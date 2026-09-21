import assert from "node:assert/strict";
import test from "node:test";
import {
  IbkrClient,
  type EquityContract,
  type EquityOrderPreviewRequest,
  type EquityOrderRequest,
} from "../src/index.js";
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

  constructor(private readonly responder: (input: RequestInput) => unknown | Promise<unknown>) {
    super(config);
  }

  protected override async sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    return (await this.responder(input)) as T;
  }
}

const contract: EquityContract = {
  conid: 320227571,
  assetClass: "STK",
  symbol: "IBIT",
  exchange: "SMART",
  primaryExchange: "NASDAQ",
  currency: "USD",
};

type EquityLimitOrderRequest = Extract<EquityOrderRequest, { orderType: "LMT" }>;
type EquityStopOrderRequest = Extract<EquityOrderRequest, { orderType: "STP" }>;

function request(overrides: Partial<EquityLimitOrderRequest> = {}): EquityOrderRequest {
  return {
    accountId: "U123",
    contract,
    side: "BUY",
    quantity: 100,
    orderType: "LMT",
    limit: 44.41,
    tif: "DAY",
    session: "REGULAR",
    clientOrderId: "huskly-equity-1",
    ...overrides,
  };
}

function stopRequest(overrides: Partial<EquityStopOrderRequest> = {}): EquityOrderRequest {
  return {
    accountId: "U123",
    contract,
    side: "SELL",
    quantity: 25,
    orderType: "STP",
    stopPrice: 40.15,
    tif: "GTC",
    session: "OVERNIGHT",
    clientOrderId: "huskly-equity-stop-1",
    ...overrides,
  };
}

/** Builds a request whose shape is intentionally outside the public union. */
function invalidRequest(overrides: Record<string, unknown>): EquityOrderRequest {
  const { orderType: _orderType, limit: _limit, ...shared } = request() as EquityLimitOrderRequest;
  return { ...shared, ...overrides } as unknown as EquityOrderRequest;
}

function session(input: RequestInput): unknown {
  if (input.path === "iserver/auth/status")
    return { authenticated: true, connected: true, competing: false };
  if (input.path === "iserver/accounts")
    return {
      accounts: ["U123"],
      selectedAccount: "U123",
      isPaper: true,
      allowFeatures: { allowedAssetTypes: "STK" },
    };
  if (input.path === "iserver/marketdata/snapshot") return [];
  throw new Error(`Unexpected request: ${input.path}`);
}

const whatIf = {
  amount: { commission: "1.00 USD" },
  initial: { current: "10000", change: "4441", after: "14441" },
  maintenance: { current: "9000", change: "4000", after: "13000" },
  warn: null,
  error: null,
};

void test("equity What-If sends one non-submitting limit order", async () => {
  const api = new FakeIbkrClient((input) =>
    input.path === "iserver/account/U123/orders/whatif" ? whatIf : session(input)
  );
  const { clientOrderId: _clientOrderId, ...preview } = request();
  const result = await api.previewEquityOrder(preview);
  assert.equal(result.accepted, true);
  assert.equal(result.submitted, false);
  assert.equal(result.environment, "paper");
  assert.equal(result.commission, 1);
  const call = api.calls.find(({ path }) => path.endsWith("/orders/whatif"));
  assert.deepEqual(call?.data, {
    orders: [
      {
        acctId: "U123",
        conid: 320227571,
        orderType: "LMT",
        side: "BUY",
        price: 44.41,
        tif: "DAY",
        quantity: 100,
        outsideRTH: false,
      },
    ],
  });
  assert.equal(api.calls.filter(({ path }) => path.endsWith("/orders/whatif")).length, 1);
});

void test("equity STOP What-If sends one native stop-market order for BUY and SELL", async () => {
  for (const side of ["BUY", "SELL"] as const) {
    const api = new FakeIbkrClient((input) =>
      input.path === "iserver/account/U123/orders/whatif" ? whatIf : session(input)
    );
    const { clientOrderId: _clientOrderId, ...preview } = stopRequest({ side });
    const result = await api.previewEquityOrder(preview);
    assert.equal(result.accepted, true);
    assert.equal(result.submitted, false);
    const whatIfCalls = api.calls.filter(({ path }) => path.endsWith("/orders/whatif"));
    assert.equal(whatIfCalls.length, 1);
    assert.equal(whatIfCalls[0]?.method, "POST");
    assert.deepEqual(whatIfCalls[0]?.data, {
      orders: [
        {
          acctId: "U123",
          conid: 320227571,
          orderType: "STP",
          side,
          price: 40.15,
          tif: "GTC",
          quantity: 25,
          outsideRTH: true,
        },
      ],
    });
    assert.equal(
      api.calls.some(({ path }) => path === "iserver/account/U123/orders"),
      false
    );
  }
});

void test("equity STOP submission sends the same native mapping with a stable client order ID", async () => {
  for (const side of ["BUY", "SELL"] as const) {
    const api = new FakeIbkrClient((input) =>
      input.path === "iserver/account/U123/orders"
        ? [{ order_id: "9", order_status: "PreSubmitted" }]
        : session(input)
    );
    const result = await api.submitEquityOrder(
      stopRequest({ side, tif: "DAY", session: "REGULAR" })
    );
    assert.equal(result.state, "accepted");
    const writes = api.calls.filter(({ path }) => path === "iserver/account/U123/orders");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.data, {
      orders: [
        {
          acctId: "U123",
          conid: 320227571,
          orderType: "STP",
          side,
          price: 40.15,
          tif: "DAY",
          quantity: 25,
          outsideRTH: false,
          cOID: "huskly-equity-stop-1",
        },
      ],
    });
    assert.equal(
      api.calls.some(({ path }) => path.endsWith("/orders/whatif")),
      false
    );
  }
});

void test("equity order validation rejects invalid order terms before any broker request", async () => {
  const cases: { name: string; value: EquityOrderRequest; message: RegExp }[] = [
    {
      name: "unknown order type",
      value: invalidRequest({ orderType: "MKT" }),
      message: /Equity order type must be LMT or STP/,
    },
    {
      name: "LMT without limit",
      value: invalidRequest({ orderType: "LMT" }),
      message: /Equity LIMIT order requires a positive limit price/,
    },
    {
      name: "STP without stop price",
      value: invalidRequest({ orderType: "STP" }),
      message: /Equity STOP order requires a positive stop price/,
    },
    {
      name: "LMT with stop price",
      value: invalidRequest({ orderType: "LMT", limit: 44.41, stopPrice: 40 }),
      message: /Equity LIMIT order must not carry a stop price/,
    },
    {
      name: "STP with limit",
      value: invalidRequest({ orderType: "STP", stopPrice: 40, limit: 44.41 }),
      message: /Equity STOP order must not carry a limit price/,
    },
    {
      name: "STP zero stop price",
      value: stopRequest({ stopPrice: 0 }),
      message: /Equity STOP order requires a positive stop price/,
    },
    {
      name: "STP negative stop price",
      value: stopRequest({ stopPrice: -40 }),
      message: /Equity STOP order requires a positive stop price/,
    },
    {
      name: "STP NaN stop price",
      value: stopRequest({ stopPrice: Number.NaN }),
      message: /Equity STOP order requires a positive stop price/,
    },
    {
      name: "STP infinite stop price",
      value: stopRequest({ stopPrice: Number.POSITIVE_INFINITY }),
      message: /Equity STOP order requires a positive stop price/,
    },
    {
      name: "LMT negative limit",
      value: request({ limit: -1 }),
      message: /Equity LIMIT order requires a positive limit price/,
    },
    {
      name: "LMT non-finite limit",
      value: request({ limit: Number.NaN }),
      message: /Equity LIMIT order requires a positive limit price/,
    },
  ];
  for (const { name, value, message } of cases) {
    const api = new FakeIbkrClient(() => {
      throw new Error(`broker must not be called for ${name}`);
    });
    const { clientOrderId: _clientOrderId, ...preview } = value;
    await assert.rejects(() => api.submitEquityOrder(value), message, name);
    await assert.rejects(
      () => api.previewEquityOrder(preview as EquityOrderPreviewRequest),
      message,
      name
    );
    assert.equal(api.calls.length, 0, name);
  }
});

void test("equity BUY and SELL submission use one exact broker write", async () => {
  for (const side of ["BUY", "SELL"] as const) {
    const api = new FakeIbkrClient((input) =>
      input.path === "iserver/account/U123/orders"
        ? [{ order_id: side === "BUY" ? "1" : "2", order_status: "PreSubmitted" }]
        : session(input)
    );
    const result = await api.submitEquityOrder(request({ side }));
    assert.equal(result.state, "accepted");
    const writes = api.calls.filter(({ path }) => path === "iserver/account/U123/orders");
    assert.equal(writes.length, 1);
    const ticket = (writes[0]?.data as { orders: Record<string, unknown>[] }).orders[0];
    assert.equal(ticket?.["side"], side);
    assert.equal(ticket?.["cOID"], "huskly-equity-1");
    assert.equal("extOperator" in (ticket ?? {}), false);
  }
});

void test("equity submission preserves warning and refusal outcomes", async () => {
  const warning = new FakeIbkrClient((input) =>
    input.path === "iserver/account/U123/orders"
      ? [{ id: "reply-1", message: ["Price constraint"] }]
      : session(input)
  );
  assert.equal((await warning.submitEquityOrder(request())).state, "warning");

  const refused = new FakeIbkrClient((input) =>
    input.path === "iserver/account/U123/orders"
      ? { error: "Order rejected", statusCode: 400 }
      : session(input)
  );
  assert.equal((await refused.submitEquityOrder(request())).state, "rejected");
});

void test("equity writes are not retried after an ambiguous transport failure", async () => {
  const api = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") throw new Error("connection lost");
    return session(input);
  });
  await assert.rejects(() => api.submitEquityOrder(request()), /connection lost/);
  assert.equal(api.calls.filter(({ path }) => path === "iserver/account/U123/orders").length, 1);
});

void test("equity order validation rejects changed identity and invalid economics before access", async () => {
  const cases: EquityOrderRequest[] = [
    request({ quantity: 1.5 }),
    request({ limit: 0 }),
    request({ contract: { ...contract, currency: "CAD" } as unknown as EquityContract }),
  ];
  for (const value of cases) {
    const api = new FakeIbkrClient(() => {
      throw new Error("broker must not be called");
    });
    await assert.rejects(() => api.submitEquityOrder(value));
    assert.equal(api.calls.length, 0);
  }
});

void test("equity cancellation makes one STK request without CME metadata", async () => {
  const api = new FakeIbkrClient((input) =>
    input.method === "DELETE"
      ? { msg: "Request was submitted", account: "U123", order_id: "77", conid: 320227571 }
      : session(input)
  );
  const result = await api.cancelEquityOrder({ accountId: "U123", orderId: "77" });
  assert.equal(result.state, "requested");
  const cancellation = api.calls.find(({ method }) => method === "DELETE");
  assert.deepEqual(cancellation?.params, undefined);
});
