import assert from "node:assert/strict";
import test from "node:test";
import { IbkrClient, type EquityContract, type EquityOrderRequest } from "../src/index.js";
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

function request(overrides: Partial<EquityOrderRequest> = {}): EquityOrderRequest {
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
