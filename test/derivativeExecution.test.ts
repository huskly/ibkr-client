import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient, IbkrHttpError } from "../src/ibkr/ibkrClient.js";
import type { DerivativeComboExecutionRequest, DerivativeContract } from "../src/types.js";
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
  assetClass: DerivativeContract["assetClass"] = "FOP"
): DerivativeContract {
  return {
    conid,
    assetClass,
    underlying: assetClass === "OPT" ? "SPY" : "NQ",
    expiration: "2026-08-21",
    strike,
    right: "P",
    tradingClass: assetClass === "OPT" ? "SPY" : "QN3",
    exchange: assetClass === "OPT" ? "SMART" : "CME",
    multiplier: 20,
  };
}

function equityOptionExecutionRequest(): DerivativeComboExecutionRequest {
  return {
    accountId: "U123",
    legs: [
      { contract: contract(111, 620, "OPT"), ratio: 1 },
      { contract: contract(222, 625, "OPT"), ratio: -1 },
    ],
    quantity: 1,
    orderType: "LMT",
    priceEffect: "CREDIT",
    limit: 0.96,
    tif: "DAY",
    session: "REGULAR",
    clientOrderId: "huskly-spy-vertical",
  };
}

function executionRequest(): DerivativeComboExecutionRequest {
  return {
    accountId: "U123",
    legs: [
      { contract: contract(892767804, 26400), ratio: 1 },
      { contract: contract(892767774, 26600), ratio: -1 },
    ],
    quantity: 1,
    orderType: "LMT",
    priceEffect: "CREDIT",
    limit: 39,
    tif: "DAY",
    session: "REGULAR",
    clientOrderId: "huskly-20260729-abc",
    extOperator: "felipecsl",
    manualIndicator: true,
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

void test("atomic submission includes exact ratios, signed credit, client ID, and CME metadata", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        {
          id: "reply-known",
          message: ["Price exceeds the configured percentage constraint"],
          messageIds: ["o163"],
        },
      ];
    }
    return sessionResponse(input);
  });

  const result = await client.submitDerivativeCombo(executionRequest());
  assert.equal(result.state, "warning");
  assert.equal(result.state === "warning" && result.warnings[0]?.known, true);
  const placement = client.calls.find(({ path }) => path === "iserver/account/U123/orders");
  assert.deepEqual(placement?.data, {
    orders: [
      {
        acctId: "U123",
        conidex: "28812380@CME;;;892767804/1,892767774/-1",
        orderType: "LMT",
        price: -39,
        side: "BUY",
        tif: "DAY",
        quantity: 1,
        outsideRTH: false,
        cOID: "huskly-20260729-abc",
        extOperator: "felipecsl",
        manualIndicator: true,
      },
    ],
  });
  assert.equal(client.calls.filter(({ path }) => path === "iserver/account/U123/orders").length, 1);
});

void test("combo STOP submission carries a signed stop price and reversed ratios", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ order_id: "778", order_status: "PreSubmitted" }];
    }
    return sessionResponse(input);
  });

  const result = await client.submitDerivativeCombo({
    accountId: "U123",
    legs: [
      { contract: contract(892767804, 26400), ratio: -1 },
      { contract: contract(892767774, 26600), ratio: 1 },
    ],
    quantity: 1,
    orderType: "STP",
    priceEffect: "DEBIT",
    stopPrice: 41,
    tif: "GTC",
    session: "REGULAR",
    clientOrderId: "huskly-20260729-abc-stop",
    extOperator: "felipecsl",
    manualIndicator: true,
  });
  assert.equal(result.state, "accepted");
  const placement = client.calls.find(({ path }) => path === "iserver/account/U123/orders");
  assert.deepEqual(placement?.data, {
    orders: [
      {
        acctId: "U123",
        conidex: "28812380@CME;;;892767804/-1,892767774/1",
        orderType: "STP",
        price: 41,
        side: "BUY",
        tif: "GTC",
        quantity: 1,
        outsideRTH: false,
        cOID: "huskly-20260729-abc-stop",
        extOperator: "felipecsl",
        manualIndicator: true,
      },
    ],
  });
});

void test("combo STOP rejects a non-positive stop price", async () => {
  const client = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });

  await assert.rejects(
    () =>
      client.submitDerivativeCombo({
        accountId: "U123",
        legs: [
          { contract: contract(892767804, 26400), ratio: -1 },
          { contract: contract(892767774, 26600), ratio: 1 },
        ],
        quantity: 1,
        orderType: "STP",
        priceEffect: "DEBIT",
        stopPrice: 0,
        tif: "GTC",
        session: "REGULAR",
        clientOrderId: "huskly-20260729-abc-stop",
        extOperator: "felipecsl",
        manualIndicator: true,
      }),
    /Combo stop order requires a positive stop price/
  );
  assert.equal(client.calls.length, 0);
});

void test("equity-option submission omits CME operator metadata", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [{ order_id: "777", order_status: "PreSubmitted" }];
    }
    return sessionResponse(input);
  });

  const result = await client.submitDerivativeCombo(equityOptionExecutionRequest());
  assert.equal(result.state, "accepted");
  const placement = client.calls.find(({ path }) => path === "iserver/account/U123/orders");
  const ticket = (placement?.data as { orders?: Record<string, unknown>[] } | undefined)
    ?.orders?.[0];
  assert.ok(ticket);
  assert.equal("extOperator" in ticket, false);
  assert.equal("manualIndicator" in ticket, false);
});

void test("futures-option submission fails before broker access without CME metadata", async () => {
  const client = new FakeIbkrClient(() => {
    throw new Error("broker must not be called");
  });
  const {
    extOperator: _extOperator,
    manualIndicator: _manualIndicator,
    ...request
  } = executionRequest();

  await assert.rejects(
    () => client.submitDerivativeCombo(request),
    /FOP orders require exact CME operator metadata/
  );
  assert.equal(client.calls.length, 0);
});

void test("warning replies classify well-formed IDs and reject malformed IDs", async () => {
  const responses = [
    [{ id: "malformed", message: ["Malformed warning"], messageIds: ["x999", 7] }],
    [{ id: "other-known", message: ["Stop order disclosure"], messageIds: ["o10331"] }],
    [{ id: "known", message: ["Percentage constraint"], messageIds: ["o163"] }],
    [{ order_id: "777", order_status: "PreSubmitted" }],
  ];
  const client = new FakeIbkrClient((input) => {
    if (input.path.startsWith("iserver/reply/")) return responses.shift();
    return sessionResponse(input);
  });

  const malformed = await client.acknowledgeOrderWarning({
    accountId: "U123",
    replyId: "malformed",
    confirmed: true,
  });
  assert.equal(malformed.state === "warning" && malformed.warnings[0]?.known, false);
  const otherKnown = await client.acknowledgeOrderWarning({
    accountId: "U123",
    replyId: "other-known",
    confirmed: true,
  });
  assert.equal(otherKnown.state === "warning" && otherKnown.warnings[0]?.known, true);
  const known = await client.acknowledgeOrderWarning({
    accountId: "U123",
    replyId: "known",
    confirmed: true,
  });
  assert.equal(known.state === "warning" && known.warnings[0]?.known, true);
  const accepted = await client.acknowledgeOrderWarning({
    accountId: "U123",
    replyId: "final",
    confirmed: true,
  });
  assert.deepEqual(accepted, {
    state: "accepted",
    orderId: "777",
    status: "WORKING",
    clientOrderId: null,
    warnings: [],
  });
});

void test("exact lifecycle reads retain an evicted combo's partial-fill economics", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/accounts") {
      return { accounts: ["U123"], selectedAccount: "U123" };
    }
    if (input.path === "iserver/account/order/status/777") {
      return {
        account: "U123",
        orderId: "777",
        cOID: "huskly-20260729-abc",
        status: "Submitted",
        conidex: "28812380@CME;;;892767804/1,892767774/-1",
        totalSize: 2,
        filledQuantity: 1,
        remainingQuantity: 1,
        avgPrice: -38.5,
        price: -39,
        commissionAndFees: "3.25 USD",
        lastExecutionTime_r: 1785355200000,
      };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });
  const result = await client.getDerivativeOrderStatus("U123", "777");
  assert.equal(result.status, "PARTIALLY_FILLED");
  assert.equal(result.averagePrice, -38.5);
  assert.equal(result.commissionAndFees, 3.25);
  assert.deepEqual(result.legs, [
    { conid: 892767804, ratio: 1 },
    { conid: 892767774, ratio: -1 },
  ]);
  assert.equal(
    client.calls.some(({ path }) => path === "iserver/account/orders"),
    false
  );
  assert.equal(
    client.calls.some(({ path }) => path === "iserver/account/order/status/777"),
    true
  );
});

void test("lifecycle derives the remainder when IBKR reports only total and filled sizes", async () => {
  // `iserver/account/order/status/{orderId}` carries no remaining-quantity field at all. This is
  // the real payload shape of a resting combo (BAG) limit order on a paper account.
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/accounts") {
      return { accounts: ["DUR318631"], selectedAccount: "DUR318631" };
    }
    if (input.path === "iserver/account/order/status/980150331") {
      return {
        account: "DUR318631",
        order_id: 980150331,
        cOID: "pcs-entry-afa2ac2f",
        order_status: "Submitted",
        conidex: "28812380;;;906570511/-1,907108616/1",
        sec_type: "BAG",
        order_type: "LIMIT",
        limit_price: "-1.11",
        size: "1.0",
        total_size: "1.0",
        cum_fill: "0.0",
        size_and_fills: "0/1",
        tif: "DAY",
      };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });
  const result = await client.getDerivativeOrderStatus("DUR318631", "980150331");
  assert.equal(result.status, "WORKING");
  assert.equal(result.quantity, 1);
  assert.equal(result.filledQuantity, 0);
  assert.equal(result.remainingQuantity, 1);
});

void test("lifecycle still fails closed when the filled quantity itself is missing", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/accounts") {
      return { accounts: ["U123"], selectedAccount: "U123" };
    }
    if (input.path === "iserver/account/order/status/777") {
      return { account: "U123", order_id: 777, order_status: "Submitted", total_size: "1.0" };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });
  await assert.rejects(
    () => client.getDerivativeOrderStatus("U123", "777"),
    /returned incomplete fill quantities/
  );
});

void test("customer order IDs resolve the same typed lifecycle", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/accounts") {
      return { accounts: ["U123"], selectedAccount: "U123" };
    }
    if (input.path === "iserver/account/orders") {
      return {
        orders: [
          {
            account: "U123",
            orderId: "777",
            cOID: "huskly-20260729-abc",
            status: "Submitted",
            totalSize: 2,
            filledQuantity: 0,
            remainingQuantity: 2,
          },
        ],
      };
    }
    if (input.path === "iserver/account/order/status/777") {
      return {
        account: "U123",
        orderId: "777",
        cOID: "huskly-20260729-abc",
        status: "Submitted",
        totalSize: 2,
        filledQuantity: 0,
        remainingQuantity: 2,
      };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });

  const result = await client.findDerivativeOrder({
    accountId: "U123",
    clientOrderId: "huskly-20260729-abc",
  });
  assert.equal(result.orderId, "777");
  assert.equal(result.clientOrderId, "huskly-20260729-abc");
  assert.equal(result.status, "WORKING");
  assert.deepEqual(
    client.calls
      .filter(({ path }) => path === "iserver/account/orders")
      .map(({ params }) => params),
    [{ accountId: "U123" }]
  );
});

void test("trade reads expose per-leg executions and commissions", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/accounts") {
      return { accounts: ["U123"], selectedAccount: "U123" };
    }
    if (input.path === "iserver/account/trades") {
      return [
        {
          execution_id: "exec-long",
          account: "U123",
          order_ref: "huskly-20260729-abc",
          order_id: "777",
          conid: 892767804,
          contract_description_1: "NQ AUG 26 26400 Put",
          side: "B",
          size: 1,
          price: "19.25",
          commission: "2.05 USD",
          net_amount: -387,
          trade_time_r: 1785355200000,
          exchange: "CME",
        },
        {
          execution_id: "exec-short",
          account: "U123",
          order_ref: "huskly-20260729-abc",
          order_id: "777",
          conid: 892767774,
          symbol: "QN3",
          side: "S",
          size: 1,
          price: "58.25",
          commission: "2.15 USD",
          net_amount: 1163,
          trade_time: "20260729-20:00:01",
          exchange: "CME",
        },
        {
          execution_id: "other-account",
          account: "U999",
          order_ref: "huskly-20260729-abc",
          conid: 1,
        },
      ];
    }
    throw new Error(`Unexpected request ${input.path}`);
  });

  const executions = await client.getDerivativeExecutions({
    accountId: "U123",
    clientOrderId: "huskly-20260729-abc",
    days: 7,
  });
  assert.deepEqual(executions, [
    {
      accountId: "U123",
      executionId: "exec-long",
      orderId: "777",
      clientOrderId: "huskly-20260729-abc",
      conid: 892767804,
      symbol: "NQ AUG 26 26400 Put",
      side: "BUY",
      quantity: 1,
      price: 19.25,
      commission: 2.05,
      commissionCurrency: "USD",
      netAmount: -387,
      exchange: "CME",
      executedAt: "2026-07-29T20:00:00.000Z",
    },
    {
      accountId: "U123",
      executionId: "exec-short",
      orderId: "777",
      clientOrderId: "huskly-20260729-abc",
      conid: 892767774,
      symbol: "QN3",
      side: "SELL",
      quantity: 1,
      price: 58.25,
      commission: 2.15,
      commissionCurrency: "USD",
      netAmount: 1163,
      exchange: "CME",
      executedAt: "2026-07-29T20:00:01.000Z",
    },
  ]);
  assert.deepEqual(client.calls.find(({ path }) => path === "iserver/account/trades")?.params, {
    days: 7,
  });
});

void test("lifecycle normalizes terminal filled, canceled, and rejected states", async () => {
  for (const [raw, expected] of [
    ["Filled", "FILLED"],
    ["Cancelled", "CANCELED"],
    ["Inactive", "REJECTED"],
  ] as const) {
    const client = new FakeIbkrClient((input) => {
      if (input.path === "iserver/accounts") {
        return { accounts: ["U123"], selectedAccount: "U123" };
      }
      if (input.path === "iserver/account/order/status/777") {
        return {
          account: "U123",
          orderId: "777",
          status: raw,
          totalSize: 1,
          filledQuantity: raw === "Filled" ? 1 : 0,
          remainingQuantity: 0,
        };
      }
      throw new Error(`Unexpected request ${input.path}`);
    });
    assert.equal((await client.getDerivativeOrderStatus("U123", "777")).status, expected);
  }
});

void test("exact lifecycle lookup fails closed on identity or status mismatch", async () => {
  for (const fixture of [
    { account: "U999", orderId: "777", status: "Filled" },
    { account: "U123", orderId: "999", status: "Filled" },
    { account: "U123", orderId: "777", status: "MysteryState" },
  ]) {
    const client = new FakeIbkrClient((input) => {
      if (input.path === "iserver/accounts") {
        return { accounts: ["U123"], selectedAccount: "U123" };
      }
      if (input.path === "iserver/account/order/status/777") {
        return { ...fixture, totalSize: 1, filledQuantity: 1, remainingQuantity: 0 };
      }
      throw new Error(`Unexpected request ${input.path}`);
    });
    await assert.rejects(
      () => client.getDerivativeOrderStatus("U123", "777"),
      /does not (belong to the requested account|match the requested order)|unrecognized status/
    );
  }
});

void test("legacy warning acknowledgement requires an exact safe account", async () => {
  const missingAccount = new FakeIbkrClient(() => {
    throw new Error("Broker access was not expected");
  });
  await assert.rejects(
    missingAccount.acknowledgeOrderWarning({
      accountId: "",
      replyId: "reply",
      confirmed: true,
    }),
    /exact account ID/
  );
  assert.deepEqual(missingAccount.calls, []);

  const disconnected = new FakeIbkrClient((input) => {
    if (input.path === "iserver/auth/status") {
      return { authenticated: true, connected: false, competing: false };
    }
    if (input.path === "iserver/accounts") {
      return { accounts: ["U123"], selectedAccount: "U123", isPaper: true };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });
  await assert.rejects(
    disconnected.acknowledgeOrderWarning({
      accountId: "U123",
      replyId: "reply",
      confirmed: true,
    }),
    /not safely authenticated/
  );
  assert.ok(disconnected.calls.every(({ path }) => !path.startsWith("iserver/reply/")));
});

void test("account preparation rejects a selected account without valid account-list evidence", async () => {
  let accountReads = 0;
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/auth/status") {
      return { authenticated: true, connected: true, competing: false };
    }
    if (input.path === "iserver/accounts") {
      accountReads += 1;
      return accountReads === 1
        ? { accounts: ["U123"], selectedAccount: "U123", isPaper: true }
        : { selectedAccount: "U123" };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });

  await assert.rejects(
    client.cancelDerivativeOrder({ accountId: "U123", orderId: "777", assetClass: "OPT" }),
    /not available for trading/
  );
  assert.ok(client.calls.every(({ method }) => method !== "DELETE"));
});

void test("cancel sends one explicit request and returns a typed request acknowledgement", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/auth/status") {
      return { authenticated: true, connected: true, competing: false };
    }
    if (input.path === "iserver/accounts") {
      return { accounts: ["U123"], selectedAccount: "U123", isPaper: true };
    }
    if (input.method === "DELETE") {
      return { msg: "Request was submitted", order_id: "777", account: "U123", conid: 123 };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });
  const result = await client.cancelDerivativeOrder({
    accountId: "U123",
    orderId: "777",
    assetClass: "FOP",
    extOperator: "felipecsl",
    manualIndicator: true,
  });
  assert.deepEqual(client.calls.at(-1), {
    path: "iserver/account/U123/order/777",
    method: "DELETE",
    params: { extOperator: "felipecsl", manualIndicator: true },
  });
  assert.deepEqual(result, {
    state: "requested",
    accountId: "U123",
    orderId: "777",
    message: "Request was submitted",
  });
});

void test("structured broker rejections are preserved", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return {
        error: { code: "ORDER_REJECTED", message: "Order is not permitted", leg: 2 },
        statusCode: 400,
      };
    }
    return sessionResponse(input);
  });

  const result = await client.submitDerivativeCombo(executionRequest());
  assert.deepEqual(result, {
    state: "rejected",
    reasons: ["Order is not permitted"],
    errors: [
      {
        message: "Order is not permitted",
        code: "ORDER_REJECTED",
        statusCode: 400,
        details: {
          error: { code: "ORDER_REJECTED", message: "Order is not permitted", leg: 2 },
          statusCode: 400,
        },
      },
    ],
  });
});

void test("placement transport errors retain their structured details and are never retried", async () => {
  const transportError = Object.assign(new Error("broker unavailable"), {
    status: 503,
    response: { data: { error: { code: "BROKER_DOWN", retryable: false } } },
  });
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") throw transportError;
    return sessionResponse(input);
  });

  await assert.rejects(client.submitDerivativeCombo(executionRequest()), (error) => {
    assert.ok(error instanceof IbkrHttpError);
    assert.equal(error.status, 503);
    assert.deepEqual(error.response, {
      status: 503,
      body: '{"error":{"code":"BROKER_DOWN","retryable":false}}',
      retryAfter: null,
    });
    assert.equal(error.cause, transportError);
    return true;
  });
  assert.equal(client.calls.filter(({ path }) => path === "iserver/account/U123/orders").length, 1);
});

void test("combo recovery does not assign one client ID to multiple acknowledgements", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { order_id: "777", order_status: "PreSubmitted" },
        { order_id: "888", order_status: "PreSubmitted" },
      ];
    }
    return sessionResponse(input);
  });

  const result = await client.submitDerivativeCombo(executionRequest());
  assert.equal(result.state, "recovery_required");
  if (result.state === "recovery_required") {
    assert.deepEqual(
      result.orders.map(({ clientOrderId }) => clientOrderId),
      [null, null]
    );
  }
});

void test("combo submission requires exactly one warning continuation", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/U123/orders") {
      return [
        { id: "reply-parent", message: ["Parent warning"], messageIds: ["o163"] },
        { id: "reply-child", message: ["Child warning"], messageIds: ["o163"] },
      ];
    }
    return sessionResponse(input);
  });

  const result = await client.submitDerivativeCombo(executionRequest());
  assert.equal(result.state, "recovery_required");
  if (result.state === "recovery_required") {
    assert.deepEqual(
      result.warnings.map(({ replyId }) => replyId),
      ["reply-parent", "reply-child"]
    );
    assert.match(result.reasons[0] ?? "", /multiple warning continuations/);
  }
});

void test("equity-option cancellation omits CME operator metadata", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/auth/status") {
      return { authenticated: true, connected: true, competing: false };
    }
    if (input.path === "iserver/accounts") {
      return { accounts: ["U123"], selectedAccount: "U123", isPaper: true };
    }
    if (input.method === "DELETE") return { msg: "Request was submitted" };
    throw new Error(`Unexpected request ${input.path}`);
  });

  await client.cancelDerivativeOrder({
    accountId: "U123",
    orderId: "777",
    assetClass: "OPT",
  });
  assert.deepEqual(client.calls.at(-1), {
    path: "iserver/account/U123/order/777",
    method: "DELETE",
  });
});

void test("the exact read describes a resting combo stop with its type and trigger", async () => {
  // Real payload shape of a resting protective combo stop: the trigger lives in `stop_price`,
  // and no limit price is present at all.
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/accounts") {
      return { accounts: ["DUR318631"], selectedAccount: "DUR318631" };
    }
    if (input.path === "iserver/account/order/status/980150332") {
      return {
        account: "DUR318631",
        order_id: 980150332,
        order_status: "PreSubmitted",
        order_type: "STP",
        stop_price: "2.22",
        size: "1.0",
        total_size: "1.0",
        cum_fill: "0.0",
        parent_order_id: "980150331",
        order_desc: "Buy 1 Stop 2.22, GTC",
        conidex: "28812380;;;906570511/-1,907108616/1",
      };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });
  const result = await client.getDerivativeOrderStatus("DUR318631", "980150332");
  assert.equal(result.orderType, "STOP");
  assert.equal(result.stopPrice, 2.22);
  assert.equal(result.limitPrice, null);
  assert.equal(result.status, "WORKING");
});

void test("the exact read leaves the stop trigger null when IBKR sends none", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/accounts") {
      return { accounts: ["DUR318631"], selectedAccount: "DUR318631" };
    }
    if (input.path === "iserver/account/order/status/980150331") {
      return {
        account: "DUR318631",
        order_id: 980150331,
        order_status: "Submitted",
        order_type: "LIMIT",
        limit_price: "-1.11",
        size: "1.0",
        total_size: "1.0",
        cum_fill: "0.0",
        conidex: "28812380;;;906570511/-1,907108616/1",
      };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });
  const result = await client.getDerivativeOrderStatus("DUR318631", "980150331");
  assert.equal(result.orderType, "LIMIT");
  assert.equal(result.limitPrice, -1.11);
  assert.equal(result.stopPrice, null);
});

void test("the exact read and the active snapshot agree on one resting stop", async () => {
  const stopRow = {
    account: "DUR318631",
    order_id: 980150332,
    orderId: "980150332",
    order_status: "PreSubmitted",
    order_type: "STP",
    stop_price: "2.22",
    size: "1.0",
    total_size: "1.0",
    cum_fill: "0.0",
    side: "B",
    conidex: "28812380;;;906570511/-1,907108616/1",
  };
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/accounts") {
      return { accounts: ["DUR318631"], selectedAccount: "DUR318631" };
    }
    if (input.path === "iserver/account/order/status/980150332") return stopRow;
    if (input.path === "iserver/account/orders") return { snapshot: true, orders: [stopRow] };
    throw new Error(`Unexpected request ${input.path}`);
  });
  const exact = await client.getDerivativeOrderStatus("DUR318631", "980150332");
  const [active] = await client.listActiveDerivativeOrders("DUR318631");
  assert.equal(exact.orderType, active?.orderType);
  assert.equal(exact.stopPrice, active?.stopPrice);
});
