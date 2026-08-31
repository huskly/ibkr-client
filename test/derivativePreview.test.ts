import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient } from "../src/ibkr/ibkrClient.js";
import type { DerivativeComboPreviewRequest, DerivativeContract } from "../src/types.js";
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

function contract(conid: number, strike: number): DerivativeContract {
  return {
    conid,
    assetClass: "FOP",
    underlying: "NQ",
    expiration: "2026-08-21",
    strike,
    right: "P",
    tradingClass: "QN3",
    exchange: "CME",
    multiplier: 20,
  };
}

function request(): DerivativeComboPreviewRequest {
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
  };
}

function responder(input: RequestInput): unknown {
  if (input.path === "iserver/auth/status") return { authenticated: true, competing: false };
  if (input.path === "iserver/accounts") {
    return {
      accounts: ["U123"],
      selectedAccount: "U123",
      isPaper: true,
      // Deliberately stale/incomplete: a successful What-If remains authoritative.
      allowFeatures: { showGFIS: true, allowedAssetTypes: "STK" },
    };
  }
  if (input.path === "iserver/marketdata/snapshot") return [];
  if (input.path.endsWith("/orders/whatif")) {
    return {
      amount: { commission: "2.50 USD" },
      initial: { current: "10,000", change: "3,220", after: "13,220" },
      maintenance: { current: "9,000", change: "3,000", after: "12,000" },
      warn: null,
      error: null,
    };
  }
  throw new Error(`Unexpected request ${input.path}`);
}

void test("What-If builds one atomic NQ combo and hides IBKR's signed credit encoding", async () => {
  const client = new FakeIbkrClient(responder);
  const result = await client.previewDerivativeCombo(request());

  assert.equal(result.accepted, true);
  assert.equal(result.submitted, false);
  assert.equal(result.environment, "paper");
  assert.equal(result.commission, 2.5);
  assert.equal(result.initialMargin?.change, 3220);
  assert.deepEqual(result.advisoryAssetPermissions, ["STK"]);
  const whatIf = client.calls.find(({ path }) => path.endsWith("/orders/whatif"));
  assert.deepEqual(whatIf?.data, {
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
      },
    ],
  });
  assert.ok(client.calls.every(({ path }) => !path.endsWith("/orders")));
  assert.ok(client.calls.every(({ path }) => !path.includes("/reply/")));
});

void test("diagnostics require an exact account and distinguish live from paper", async () => {
  const paper = new FakeIbkrClient(responder);
  assert.equal((await paper.getTradingDiagnostics("U123")).environment, "paper");

  const live = new FakeIbkrClient((input) => {
    if (input.path === "iserver/auth/status") return { authenticated: true };
    if (input.path === "iserver/accounts") {
      return { accounts: ["U999"], selectedAccount: "U999", isPaper: false };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });
  assert.equal((await live.getTradingDiagnostics("U999")).environment, "live");
  await assert.rejects(() => live.getTradingDiagnostics("U123"), /not available/);
  await assert.rejects(() => live.getTradingDiagnostics(""), /explicit IBKR account ID/);
});

void test("What-If fails closed when competition evidence is missing", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/auth/status") return { authenticated: true };
    if (input.path === "iserver/accounts") {
      return { accounts: ["U123"], selectedAccount: "U123", isPaper: true };
    }
    throw new Error(`Unexpected request ${input.path}`);
  });

  await assert.rejects(() => client.previewDerivativeCombo(request()), /not safely authenticated/);
  assert.ok(client.calls.every(({ path }) => !path.endsWith("/orders/whatif")));
});

void test("What-If response is authoritative and incomplete success fails closed", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "iserver/auth/status") {
      return { authenticated: true, competing: false };
    }
    if (input.path === "iserver/accounts") {
      return {
        accounts: ["U123"],
        selectedAccount: "U123",
        isPaper: false,
        allowFeatures: { allowedAssetTypes: "STK" },
      };
    }
    if (input.path === "iserver/marketdata/snapshot") return [];
    if (input.path.endsWith("/orders/whatif")) return { warn: "permission metadata is stale" };
    throw new Error(`Unexpected request ${input.path}`);
  });
  const result = await client.previewDerivativeCombo(request());
  assert.equal(result.accepted, false);
  assert.deepEqual(result.rejectionReasons, ["IBKR returned an incomplete What-If result"]);
  assert.deepEqual(result.warnings, ["permission metadata is stale"]);
});
