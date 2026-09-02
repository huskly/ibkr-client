import test from "node:test";
import assert from "node:assert/strict";
import { IbkrClient } from "../src/ibkr/ibkrClient.js";
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

const PINNED_NOW = 1_754_000_000_000;

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

  protected override now(): number {
    return PINNED_NOW;
  }
}

/**
 * A client whose position read would refuse every conid this test asks about.
 *
 * The point of this read is that it never consults held positions: the contract it asks about is
 * exactly the one the account no longer holds. A responder that throws on the position endpoint
 * proves the read never went there.
 */
function clientForTransactions(response: object, accountId = "U123"): FakeIbkrClient {
  return new FakeIbkrClient((input) => {
    if (input.path === "portfolio/accounts") return [{ accountId }];
    if (input.path === "pa/transactions") return response;
    throw new Error(`Unexpected request: ${input.path}`);
  });
}

void test("getContractTransactionEvidence reads a contract the account no longer holds", async () => {
  const client = clientForTransactions({
    transactions: [
      {
        date: "Mon Sep 21 00:00:00 EDT 2026",
        rawDate: "20260921",
        cur: "USD",
        fxRate: 1,
        pr: 0,
        qty: -1,
        acctid: "U123",
        amt: -36_000,
        conid: 726,
        type: "Assignment",
        desc: "ASSIGNED PUT SPY 21SEP26 360 P",
      },
    ],
  });

  const evidence = await client.getContractTransactionEvidence({
    conids: [726],
    currency: "USD",
    days: 30,
  });

  assert.deepEqual(evidence, {
    accountId: "U123",
    observedAtEpochMillis: PINNED_NOW,
    requestedConids: [726],
    requestedCurrency: "USD",
    requestedDays: 30,
    transactions: [
      {
        conid: 726,
        accountId: "U123",
        date: "Mon Sep 21 00:00:00 EDT 2026",
        rawDate: "20260921",
        type: "Assignment",
        description: "ASSIGNED PUT SPY 21SEP26 360 P",
        currency: "USD",
        amount: -36_000,
        quantity: -1,
        price: 0,
        fxRate: 1,
        presentFieldNames: [
          "acctid",
          "amt",
          "conid",
          "cur",
          "date",
          "desc",
          "fxRate",
          "pr",
          "qty",
          "rawDate",
          "type",
        ],
      },
    ],
  });

  // It asks the broker directly, and it never reads held positions to get there.
  assert.deepEqual(
    client.calls.map((call) => call.path),
    ["portfolio/accounts", "pa/transactions"]
  );
  const [, request] = client.calls;
  assert.equal(request?.method, "POST");
  assert.deepEqual(request?.data, {
    acctIds: ["U123"],
    conids: [726],
    currency: "USD",
    days: 30,
  });
});

void test("getContractTransactionEvidence states the broker's own label without mapping it", async () => {
  const client = clientForTransactions({
    transactions: [
      { conid: 726, type: "exercise", desc: "some prose", cur: "eur" },
      { conid: 727, type: "Expired", desc: null },
    ],
  });

  const evidence = await client.getContractTransactionEvidence({
    conids: [726, 727],
    currency: "USD",
    days: 7,
  });

  // Case is preserved exactly; nothing is uppercased, classified, or renamed.
  assert.equal(evidence.transactions[0]?.type, "exercise");
  assert.equal(evidence.transactions[0]?.currency, "eur");
  assert.equal(evidence.transactions[1]?.type, "Expired");
  assert.equal(evidence.transactions[1]?.description, null);
});

void test("getContractTransactionEvidence reads a silent field as null and never as zero", async () => {
  const client = clientForTransactions({
    transactions: [{ conid: 726, amt: 0, qty: 0, pr: 0 }, {}],
  });

  const evidence = await client.getContractTransactionEvidence({
    conids: [726],
    currency: "USD",
    days: 1,
  });

  // A stated zero stays 0. Silence reads null. The two must never collapse together.
  assert.equal(evidence.transactions[0]?.amount, 0);
  assert.equal(evidence.transactions[0]?.quantity, 0);
  assert.equal(evidence.transactions[0]?.price, 0);
  assert.equal(evidence.transactions[0]?.currency, null);
  assert.equal(evidence.transactions[0]?.type, null);
  assert.equal(evidence.transactions[1]?.conid, null);
  assert.equal(evidence.transactions[1]?.amount, null);
  assert.deepEqual(evidence.transactions[1]?.presentFieldNames, []);
});

void test("getContractTransactionEvidence states an empty response as an empty list", async () => {
  const client = clientForTransactions({});
  const evidence = await client.getContractTransactionEvidence({
    conids: [726],
    currency: "USD",
    days: 1,
  });
  assert.deepEqual(evidence.transactions, []);
});

/**
 * The currency is the caller's decision. `fetchTransactionHistory` defaults it from the
 * environment and falls back to `"USD"`; this read must never do either, because a wrong currency
 * silently returns a converted figure that looks exactly like a real one.
 */
void test("getContractTransactionEvidence refuses a currency the caller did not state", async () => {
  const client = clientForTransactions({});
  for (const currency of ["", "   "]) {
    await assert.rejects(
      () => client.getContractTransactionEvidence({ conids: [726], currency, days: 1 }),
      /currency/i,
      currency
    );
  }
});

void test("getContractTransactionEvidence refuses an identity it cannot ask about", async () => {
  const client = clientForTransactions({});
  const refused: readonly [string, number[]][] = [
    ["no conid", []],
    ["a zero conid", [0]],
    ["a negative conid", [-1]],
    ["a fractional conid", [1.5]],
  ];
  for (const [name, conids] of refused) {
    await assert.rejects(
      () => client.getContractTransactionEvidence({ conids, currency: "USD", days: 1 }),
      /conid/i,
      name
    );
  }
});

void test("getContractTransactionEvidence refuses a window the endpoint cannot serve", async () => {
  const client = clientForTransactions({});
  for (const days of [0, 91, 1.5]) {
    await assert.rejects(
      () => client.getContractTransactionEvidence({ conids: [726], currency: "USD", days }),
      /days/i,
      String(days)
    );
  }
});

void test("getContractTransactionEvidence accepts an explicit account without discovering one", async () => {
  const client = new FakeIbkrClient((input) => {
    if (input.path === "pa/transactions") return { transactions: [] };
    throw new Error(`Unexpected request: ${input.path}`);
  });

  const evidence = await client.getContractTransactionEvidence({
    accountId: "U999",
    conids: [726],
    currency: "USD",
    days: 1,
  });

  assert.equal(evidence.accountId, "U999");
  assert.deepEqual(
    client.calls.map((call) => call.path),
    ["pa/transactions"]
  );
});
