import assert from "node:assert/strict";
import test from "node:test";
import { IbkrClient } from "../src/ibkr/ibkrClient.js";
import type { DerivativeComboReconciliationRequest } from "../src/types.js";
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
  readonly waits: number[] = [];
  private clock = 0;

  constructor(private readonly responder: (input: RequestInput) => unknown) {
    super(config);
  }

  protected override sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    return Promise.resolve(this.responder(input) as T);
  }

  protected override wait(ms: number): Promise<void> {
    this.waits.push(ms);
    this.clock += ms;
    return Promise.resolve();
  }

  protected override now(): number {
    return this.clock;
  }
}

const request: DerivativeComboReconciliationRequest = {
  accountId: "U123",
  orderId: "777",
  clientOrderId: "huskly-spy-vertical",
  legs: [
    { conid: 885902771, ratio: 1 },
    { conid: 885902828, ratio: -1 },
  ],
  quantity: 1,
  multiplier: 100,
  timeoutMs: 5_000,
  pollMs: 1_000,
};

function status(
  value: "Filled" | "Submitted" = "Filled",
  filledQuantity = 1,
  remainingQuantity = 0
): object {
  return {
    account: "U123",
    orderId: "777",
    cOID: "huskly-spy-vertical",
    status: value,
    conidex: "28812380;;;885902771/1,885902828/-1",
    totalSize: filledQuantity + remainingQuantity,
    filledQuantity,
    remainingQuantity,
    avgPrice: -0.96,
    price: -0.95,
  };
}

const filledTrades = [
  {
    account: "U123",
    order_ref: "huskly-spy-vertical",
    execution_id: "redacted-long",
    conid: 885902771,
    side: "B",
    size: 1,
    price: 4.82,
    trade_time: "20260730-17:00:00",
    exchange: "EMERALD",
    sec_type: "OPT",
    commission: 0.8,
    net_amount: -482.8,
  },
  {
    account: "U123",
    order_ref: "huskly-spy-vertical",
    execution_id: "redacted-short",
    conid: 885902828,
    side: "S",
    size: 1,
    price: 5.78,
    trade_time: "20260730-17:00:00",
    exchange: "EMERALD",
    sec_type: "OPT",
    commission: 0.81,
    net_amount: 577.19,
  },
];

function accountResponse(input: RequestInput): unknown {
  if (input.path === "iserver/accounts") {
    return { accounts: ["U123"], selectedAccount: "U123" };
  }
  if (input.path === "iserver/account/order/status/777") return status();
  throw new Error(`Unexpected request ${input.path}`);
}

void test("reconciliation retries delayed trades and exposes gross and net economics", async () => {
  const tradeResponses: object[][] = [[], filledTrades];
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/trades") return tradeResponses.shift() ?? filledTrades;
    return accountResponse(input);
  });

  const result = await client.reconcileDerivativeComboExecution(request);
  assert.equal(result.state, "VERIFIED");
  assert.equal(result.aggregateStatus, "FILLED");
  assert.equal(result.grossPoints, 0.96);
  assert.equal(result.grossAmount, 96);
  assert.equal(result.commission, 1.61);
  assert.equal(result.netAmount, 94.39);
  assert.deepEqual(
    result.legs.map(({ conid, side, quantity, averagePrice }) => ({
      conid,
      side,
      quantity,
      averagePrice,
    })),
    [
      { conid: 885902771, side: "BUY", quantity: 1, averagePrice: 4.82 },
      { conid: 885902828, side: "SELL", quantity: 1, averagePrice: 5.78 },
    ]
  );
  assert.deepEqual(client.waits, [1_000]);
});

void test("partial aggregate fills remain pending with verified execution progress", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/order/status/777") return status("Submitted", 1, 1);
    if (input.path === "iserver/account/trades") return filledTrades;
    if (input.path === "iserver/accounts") {
      return { accounts: ["U123"], selectedAccount: "U123" };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });

  const result = await client.reconcileDerivativeComboExecution({ ...request, quantity: 2 });
  assert.equal(result.state, "PENDING");
  assert.equal(result.aggregateStatus, "PARTIALLY_FILLED");
  assert.equal(result.filledQuantity, 1);
  assert.equal(result.remainingQuantity, 1);
});

void test("duplicate or mismatched leg evidence requires recovery", async () => {
  for (const trades of [
    [filledTrades[0], filledTrades[0], filledTrades[1]],
    [{ ...filledTrades[0], side: "S" }, filledTrades[1]],
    [{ ...filledTrades[0], conid: 999999999 }, filledTrades[1]],
    [{ ...filledTrades[0], order_ref: "another-order" }, filledTrades[1]],
  ]) {
    const client = new FakeIbkrClient((input) => {
      if (input.path === "iserver/account/trades") return trades;
      return accountResponse(input);
    });
    const result = await client.reconcileDerivativeComboExecution({ ...request, timeoutMs: 0 });
    assert.equal(result.state, "RECOVERY_REQUIRED");
    assert.ok(result.reason);
  }
});

void test("missing terminal trade evidence becomes recovery-required at the deadline", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/account/trades") return [];
    return accountResponse(input);
  });

  const result = await client.reconcileDerivativeComboExecution({
    ...request,
    timeoutMs: 2_000,
    pollMs: 1_000,
  });
  assert.equal(result.state, "RECOVERY_REQUIRED");
  assert.match(result.reason ?? "", /missing.*execution evidence/i);
  assert.deepEqual(client.waits, [1_000, 1_000]);
});
