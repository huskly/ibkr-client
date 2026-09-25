import assert from "node:assert/strict";
import test from "node:test";
import {
  IbkrClient,
  normalizeForexContract,
  parseForexPair,
  type ForexContract,
  type ForexOrderPreviewRequest,
  type ForexOrderRequest,
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

  constructor(private readonly responder: (input: RequestInput) => unknown) {
    super(config);
  }

  protected override sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    return Promise.resolve(this.responder(input) as T);
  }
}

const contract: ForexContract = {
  conid: 15016059,
  assetClass: "CASH",
  symbol: "USD",
  currency: "JPY",
  localSymbol: "USD.JPY",
  exchange: "IDEALPRO",
};

const reference = {
  con_id: 15016059,
  symbol: "USD",
  local_symbol: "USD.JPY",
  instrument_type: "CASH",
  currency: "JPY",
  exchange: "IDEALPRO",
  valid_exchanges: "IDEALPRO",
};

const pairs = {
  USD: [
    { symbol: "USD.SGD", conid: 37928772, ccyPair: "SGD" },
    { symbol: "USD.JPY", conid: 15016059, ccyPair: "JPY" },
  ],
};

function resolver(listed: unknown = pairs, details: unknown = reference): FakeIbkrClient {
  return new FakeIbkrClient(({ path }) => {
    if (path === "iserver/currency/pairs") return listed;
    if (path === "iserver/contract/15016059/info") return details;
    throw new Error(`Unexpected request: ${path}`);
  });
}

function preview(overrides: Partial<ForexOrderPreviewRequest> = {}): ForexOrderPreviewRequest {
  return {
    accountId: "U123",
    contract,
    side: "BUY",
    quantity: 25000,
    orderType: "LMT",
    limit: 147.25,
    tif: "DAY",
    ...overrides,
  };
}

const whatIf = {
  amount: { commission: "2.00 USD" },
  initial: { current: "10000", change: "900", after: "10900" },
  maintenance: { current: "9000", change: "800", after: "9800" },
  warn: null,
  error: null,
};

const summary = { initmarginreq: { amount: 10000, currency: "USD" } };

function trader(
  answers: { whatIf?: unknown; summary?: unknown; submit?: unknown } = {}
): FakeIbkrClient {
  return new FakeIbkrClient((input) => {
    if (input.path === "iserver/auth/status")
      return { authenticated: true, connected: true, competing: false };
    if (input.path === "iserver/accounts")
      return { accounts: ["U123"], selectedAccount: "U123", isPaper: true, allowFeatures: {} };
    if (input.path === "iserver/marketdata/snapshot") return [];
    if (input.path === "iserver/account/U123/orders/whatif") return answers.whatIf ?? whatIf;
    if (input.path === "portfolio/U123/summary") return answers.summary ?? summary;
    if (input.path === "iserver/account/U123/orders")
      return answers.submit ?? [{ order_id: "9", order_status: "PreSubmitted" }];
    if (input.path === "iserver/account/U123/order/77")
      return { msg: "Request was submitted", account: "U123", order_id: "77", conid: 15016059 };
    throw new Error(`Unexpected request: ${input.path}`);
  });
}

const ticket = {
  acctId: "U123",
  conid: 15016059,
  listingExchange: "IDEALPRO",
  orderType: "LMT",
  side: "BUY",
  price: 147.25,
  tif: "DAY",
  quantity: 25000,
  isCcyConv: false,
};

void test("parseForexPair accepts only BASE.QUOTE with two different currency codes", () => {
  assert.deepEqual(parseForexPair("USD.JPY"), {
    base: "USD",
    quote: "JPY",
    localSymbol: "USD.JPY",
  });
  for (const value of ["USDJPY", "USD/JPY", "usd.jpy", "USD.USD", "US.JPY", " USD.JPY", 7]) {
    assert.equal(parseForexPair(value), null, String(value));
  }
});

void test("normalizeForexContract refuses incomplete or conflicting identity", () => {
  assert.deepEqual(normalizeForexContract(contract), contract);
  const cases: unknown[] = [
    null,
    { ...contract, assetClass: "STK" },
    { ...contract, exchange: "SMART" },
    { ...contract, symbol: "EUR" },
    { ...contract, currency: "USD" },
    { ...contract, conid: 0 },
    { ...contract, session: "REGULAR" },
  ];
  for (const value of cases) assert.equal(normalizeForexContract(value), null);
});

void test("resolves one exact currency pair and verifies its contract details", async () => {
  const api = resolver();
  assert.deepEqual(await api.resolveForexContract("USD.JPY"), contract);
  assert.deepEqual(api.calls, [
    { path: "iserver/currency/pairs", params: { currency: "USD" } },
    { path: "iserver/contract/15016059/info" },
  ]);
});

void test("uses the pair name when contract details do not state a local symbol", async () => {
  const { local_symbol: _localSymbol, ...details } = reference;
  assert.deepEqual(await resolver(pairs, details).resolveForexContract("USD.JPY"), contract);
});

void test("fails closed before details when pair evidence is missing or ambiguous", async () => {
  const cases: unknown[] = [
    {},
    { USD: [] },
    { USD: [{ symbol: "JPY.USD", conid: 1 }] },
    { USD: [{ symbol: "USD.JPY", conid: "15016059" }] },
    {
      USD: [
        { symbol: "USD.JPY", conid: 15016059 },
        { symbol: "USD.JPY", conid: 999 },
      ],
    },
  ];
  for (const listed of cases) {
    const api = resolver(listed);
    await assert.rejects(() => api.resolveForexContract("USD.JPY"), /currency pair/);
    assert.equal(api.calls.length, 1);
  }
});

void test("fails closed on incomplete or conflicting contract details", async () => {
  const cases: unknown[] = [
    null,
    {},
    { ...reference, con_id: 999 },
    { ...reference, symbol: "EUR" },
    { ...reference, local_symbol: "USD.CNH" },
    { ...reference, instrument_type: "STK" },
    { ...reference, currency: "CNH" },
    { ...reference, valid_exchanges: "SMART" },
  ];
  for (const details of cases) {
    await assert.rejects(() => resolver(pairs, details).resolveForexContract("USD.JPY"), /forex/);
  }
});

void test("rejects an unusable pair before broker access", async () => {
  const api = resolver();
  await assert.rejects(() => api.resolveForexContract("USD.USD"), /BASE\.QUOTE/);
  assert.equal(api.calls.length, 0);
});

void test("forex What-If sends one IDEALPRO limit ticket and states both currencies", async () => {
  const api = trader();
  const result = await api.previewForexOrder(preview());
  assert.equal(result.accepted, true);
  assert.equal(result.submitted, false);
  assert.equal(result.commission, 2);
  assert.equal(result.commissionCurrency, "USD");
  assert.equal(result.marginCurrency, "USD");
  assert.deepEqual(result.initialMargin, { current: 10000, change: 900, after: 10900 });
  const whatIfCalls = api.calls.filter(({ path }) => path.endsWith("/orders/whatif"));
  assert.equal(whatIfCalls.length, 1);
  assert.deepEqual(whatIfCalls[0]?.data, { orders: [ticket] });
  assert.equal(
    api.calls.some(({ path }) => path === "iserver/account/U123/orders"),
    false
  );
});

void test("forex What-If keeps broker warnings such as an odd-lot route verbatim", async () => {
  const warn = "This order will be routed as an odd lot";
  const result = await trader({ whatIf: { ...whatIf, warn } }).previewForexOrder(
    preview({ quantity: 1000 })
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(result.warnings, [warn]);
});

void test("forex What-If is not accepted when IBKR does not state a currency", async () => {
  const cases = [
    { whatIf: { ...whatIf, amount: { commission: "2.00" } } },
    { summary: { initmarginreq: { amount: 10000 } } },
    { summary: {} },
  ];
  for (const answers of cases) {
    const result = await trader(answers).previewForexOrder(preview());
    assert.equal(result.accepted, false);
    assert.deepEqual(result.rejectionReasons, ["IBKR did not state the What-If currencies"]);
  }
});

void test("forex What-If keeps the broker rejection reason", async () => {
  const result = await trader({
    whatIf: { error: "Order price is not a valid increment" },
  }).previewForexOrder(preview());
  assert.equal(result.accepted, false);
  assert.deepEqual(result.rejectionReasons, ["Order price is not a valid increment"]);
});

void test("forex submission sends the same ticket once with a stable client order ID", async () => {
  const api = trader();
  const order: ForexOrderRequest = {
    ...preview({ side: "SELL", tif: "GTC" }),
    clientOrderId: "fx-1",
  };
  const result = await api.submitForexOrder(order);
  assert.equal(result.state, "accepted");
  const writes = api.calls.filter(({ path }) => path === "iserver/account/U123/orders");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.data, {
    orders: [{ ...ticket, side: "SELL", tif: "GTC", cOID: "fx-1" }],
  });
});

void test("forex order validation rejects bad terms before any broker request", async () => {
  const cases: { value: unknown; message: RegExp }[] = [
    { value: { ...preview(), session: "REGULAR" }, message: /does not accept the field session/ },
    { value: preview({ accountId: " " }), message: /account ID/ },
    {
      value: preview({ contract: { ...contract, exchange: "SMART" } as never }),
      message: /IDEALPRO/,
    },
    { value: preview({ side: "SHORT" as never }), message: /side/ },
    { value: preview({ quantity: 1.5 }), message: /positive integer/ },
    { value: preview({ quantity: 0 }), message: /positive integer/ },
    { value: preview({ orderType: "STP" as never }), message: /type must be LMT/ },
    { value: preview({ limit: 0 }), message: /positive limit/ },
    { value: preview({ limit: Number.NaN }), message: /positive limit/ },
    { value: preview({ tif: "IOC" as never }), message: /TIF/ },
  ];
  for (const { value, message } of cases) {
    const api = trader();
    await assert.rejects(() => api.previewForexOrder(value as ForexOrderPreviewRequest), message);
    await assert.rejects(
      () => api.submitForexOrder({ ...(value as ForexOrderPreviewRequest), clientOrderId: "fx-1" }),
      message
    );
    assert.equal(api.calls.length, 0);
  }
  const api = trader();
  await assert.rejects(
    () =>
      api.previewForexOrder({ ...preview(), clientOrderId: "fx-1" } as ForexOrderPreviewRequest),
    /does not accept the field clientOrderId/
  );
  await assert.rejects(
    () => api.submitForexOrder({ ...preview(), clientOrderId: " " }),
    /Client order ID/
  );
  assert.equal(api.calls.length, 0);
});

void test("forex cancellation sends one delete without CME metadata", async () => {
  const api = trader();
  const result = await api.cancelForexOrder({ accountId: "U123", orderId: "77" });
  assert.equal(result.state, "requested");
  const cancellation = api.calls.find(({ method }) => method === "DELETE");
  assert.equal(cancellation?.path, "iserver/account/U123/order/77");
  assert.equal(cancellation?.params, undefined);
});
