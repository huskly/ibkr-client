import assert from "node:assert/strict";
import test from "node:test";
import { IbkrClient, IbkrHttpError, type IbkrClientOptions } from "../src/index.js";
import type { IbkrOauth1Config } from "../src/ibkr/oauthConfig.js";

const account = "test-account";
const otherAccount = "other-test-account";
const config: IbkrOauth1Config = {
  accessTokenSecret: "test",
  accessToken: "test",
  consumerKey: "test",
  encryption: "test",
  signature: "test",
  dhPrime: "test",
  realm: "test",
};
interface Input {
  path: string;
  method?: string;
  data?: object;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Client extends IbkrClient {
  readonly calls: Input[] = [];
  clock = 0;
  selected = account;
  responder: (input: Input) => unknown = () => undefined;
  constructor(options: IbkrClientOptions = {}) {
    super(config, options);
    (this as unknown as { raw: { init: () => Promise<void> } }).raw = {
      init: () => Promise.resolve(),
    };
  }
  protected override now(): number {
    return this.clock;
  }
  protected override wait(ms: number): Promise<void> {
    this.clock += ms;
    return Promise.resolve();
  }
  protected override sendRequest<T>(input: Input): Promise<T> {
    this.calls.push(input);
    const response = this.responder(input);
    if (response !== undefined) return Promise.resolve(response as T);
    if (input.path === "iserver/accounts")
      return Promise.resolve({
        accounts: [account, otherAccount],
        selectedAccount: this.selected,
      } as T);
    if (input.path === "iserver/account") {
      this.selected = (input.data as { acctId: string }).acctId;
      return Promise.resolve({ set: true, acctId: this.selected } as T);
    }
    if (input.path === "iserver/account/orders")
      return Promise.resolve({ snapshot: true, orders: [] } as T);
    if (input.path === "iserver/account/trades") return Promise.resolve([] as T);
    return Promise.resolve({} as T);
  }
  endpoint(input: Input): Promise<unknown> {
    return this.req(input);
  }
  verifies(): number {
    return this.calls.filter((call) => call.path === "iserver/accounts").length;
  }
}

void test("first account read verifies and later same-account reads reuse confirmation", async () => {
  const client = new Client();
  await client.listActiveDerivativeOrders(account);
  await client.getDerivativeExecutions({ accountId: account });
  assert.equal(client.verifies(), 1);
});

void test("orders and executions overlap after exclusive first preparation", async () => {
  const client = new Client();
  const orders = deferred<unknown>();
  const started = deferred<void>();
  client.responder = (input) => {
    if (input.path === "iserver/account/orders") {
      started.resolve();
      return orders.promise;
    }
    return undefined;
  };
  const pending = client.listActiveDerivativeOrders(account);
  await started.promise;
  await client.getDerivativeExecutions({ accountId: account });
  assert.equal(client.verifies(), 1);
  orders.resolve({ snapshot: true, orders: [] });
  await pending;
});

void test("a switch waits for active reads and excludes later reads", async () => {
  const client = new Client();
  const orders = deferred<unknown>();
  const started = deferred<void>();
  client.responder = (input) => {
    if (input.path === "iserver/account/orders") {
      started.resolve();
      return orders.promise;
    }
    return undefined;
  };
  const pending = client.listActiveDerivativeOrders(account);
  await started.promise;
  const switched = client.getDerivativeExecutions({ accountId: otherAccount });
  const later = client.getDerivativeExecutions({ accountId: account });
  assert.equal(
    client.calls.some((call) => call.path === "iserver/account"),
    false
  );
  orders.resolve({ snapshot: true, orders: [] });
  await Promise.all([pending, switched, later]);
  assert.equal(client.calls.filter((call) => call.path === "iserver/account").length, 2);
  assert.equal(client.selected, account);
});

void test("initialization renewal and logout each invalidate selection", async () => {
  const client = new Client();
  await client.getDerivativeExecutions({ accountId: account });
  await client.initializeBrokerageSession({ compete: false, publish: true });
  await client.getDerivativeExecutions({ accountId: account });
  await client.renewBrokerageSession({ compete: false, publish: false });
  await client.getDerivativeExecutions({ accountId: account });
  await client.logout();
  await client.getDerivativeExecutions({ accountId: account });
  assert.equal(client.verifies(), 4);
  await client.close();
  await assert.rejects(client.getDerivativeExecutions({ accountId: account }), /closed/);
  assert.equal(client.verifies(), 4);
});

void test("ambiguous scoped failure and unsafe auth evidence require fresh verification", async () => {
  const client = new Client();
  await client.getDerivativeExecutions({ accountId: account });
  let fail = true;
  client.responder = (input) => {
    if (fail && input.path === "iserver/account/trades") {
      fail = false;
      return Promise.reject(
        new IbkrHttpError("unavailable", 503, { status: 503, body: "", retryAfter: null })
      );
    }
    return undefined;
  };
  await assert.rejects(client.getDerivativeExecutions({ accountId: account }));
  await client.getDerivativeExecutions({ accountId: account });
  assert.equal(client.verifies(), 2);
  await client.getAuthStatus();
  await client.getDerivativeExecutions({ accountId: account });
  assert.equal(client.verifies(), 3);
  await client.tickle();
  await client.getDerivativeExecutions({ accountId: account });
  assert.equal(client.verifies(), 4);
});

void test("a 429 retry keeps selection and endpoint spacing", async () => {
  const client = new Client();
  let attempts = 0;
  const starts: number[] = [];
  client.responder = (input) => {
    if (input.path === "iserver/account/trades") {
      starts.push(client.clock);
      attempts += 1;
      if (attempts === 1)
        return Promise.reject(
          new IbkrHttpError("limited", 429, { status: 429, body: "", retryAfter: "1" })
        );
      return [];
    }
    return undefined;
  };
  await client.getDerivativeExecutions({ accountId: account });
  assert.equal(attempts, 2);
  assert.equal(client.verifies(), 1);
  assert.ok(starts[1]! - starts[0]! >= 5_000);
});

void test("missing or malformed account and switch evidence never confirms selection", async () => {
  for (const evidence of [null, {}, { accounts: [account, 7], selectedAccount: account }]) {
    const client = new Client();
    client.responder = (input) => (input.path === "iserver/accounts" ? evidence : undefined);
    await assert.rejects(client.getDerivativeExecutions({ accountId: account }));
    assert.equal(
      client.calls.some((call) => call.path === "iserver/account/trades"),
      false
    );
    client.responder = () => undefined;
    await client.getDerivativeExecutions({ accountId: account });
    assert.equal(client.verifies(), 2);
  }
  const client = new Client();
  client.selected = otherAccount;
  client.responder = (input) => (input.path === "iserver/account" ? null : undefined);
  await assert.rejects(client.getDerivativeExecutions({ accountId: account }));
  client.responder = () => undefined;
  await client.getDerivativeExecutions({ accountId: account });
  assert.equal(client.verifies(), 2);
});

void test("failed initialization and failed logout leave confirmation unknown", async () => {
  const client = new Client();
  await client.getDerivativeExecutions({ accountId: account });
  (client as unknown as { raw: { init: () => Promise<void> } }).raw = {
    init: () => Promise.reject(new Error("test init failure")),
  };
  await assert.rejects(client.initializeBrokerageSession({ compete: false, publish: true }));
  await client.getDerivativeExecutions({ accountId: account });
  await assert.rejects(client.renewBrokerageSession({ compete: false, publish: true }));
  await client.getDerivativeExecutions({ accountId: account });
  client.responder = (input) =>
    input.path === "logout" ? Promise.reject(new Error("test logout failure")) : undefined;
  await assert.rejects(client.logout());
  await client.getDerivativeExecutions({ accountId: account });
  assert.equal(client.verifies(), 4);
});

void test("changed session evidence invalidates but cannot populate confirmation", async () => {
  const client = new Client();
  await client.getDerivativeExecutions({ accountId: account });
  client.selected = otherAccount;
  await client.getSessionEvidence();
  await client.getDerivativeExecutions({ accountId: account });
  assert.equal(client.verifies(), 3);
  assert.equal(client.calls.filter((call) => call.path === "iserver/account").length, 1);
});

void test("close while verification is in flight cannot dispatch an account read", async () => {
  const client = new Client();
  const verification = deferred<unknown>();
  const started = deferred<void>();
  client.responder = (input) => {
    if (input.path === "iserver/accounts") {
      started.resolve();
      return verification.promise;
    }
    return undefined;
  };
  const pending = client.getDerivativeExecutions({ accountId: account });
  await started.promise;
  await client.close();
  verification.resolve({ accounts: [account], selectedAccount: account });
  await assert.rejects(pending, /closed/);
  assert.equal(
    client.calls.some((call) => call.path === "iserver/account/trades"),
    false
  );
});

void test("a mutation behind a paced read waits at most its short interval and keeps FIFO", async () => {
  const client = new Client();
  let firstMutationAt: number | undefined;
  client.responder = (input) => {
    if (input.path === "iserver/auth/status") {
      firstMutationAt ??= client.clock;
      return { authenticated: true, connected: true, competing: false };
    }
    if (input.path === "iserver/accounts")
      return {
        accounts: [account],
        selectedAccount: account,
        isPaper: true,
      };
    if (input.method === "DELETE") return { msg: "Request was submitted" };
    return undefined;
  };
  await client.getDerivativeExecutions({ accountId: account });
  const before = client.clock;
  const paced = client.getDerivativeExecutions({ accountId: account });
  const first = client.cancelEquityOrder({ accountId: account, orderId: "test-first" });
  const second = client.cancelEquityOrder({ accountId: account, orderId: "test-second" });
  await Promise.all([paced, first, second]);
  assert.ok(
    firstMutationAt !== undefined && firstMutationAt - before <= 5_300,
    `${firstMutationAt} - ${before}`
  );
  const writes = client.calls.filter((call) => call.method === "DELETE");
  assert.equal(writes.length, 2);
  assert.ok(writes[0]!.path.endsWith("test-first"));
  assert.ok(writes[1]!.path.endsWith("test-second"));
});

void test("an account mutation has one write attempt even after a 429", async () => {
  const client = new Client();
  client.responder = (input) => {
    if (input.path === "iserver/auth/status")
      return {
        authenticated: true,
        connected: true,
        competing: false,
      };
    if (input.path === "iserver/accounts")
      return {
        accounts: [account],
        selectedAccount: account,
        isPaper: true,
      };
    if (input.method === "DELETE")
      return Promise.reject(
        new IbkrHttpError("limited", 429, { status: 429, body: "", retryAfter: "1" })
      );
    return undefined;
  };
  await assert.rejects(client.cancelEquityOrder({ accountId: account, orderId: "test-order" }));
  assert.equal(client.calls.filter((call) => call.method === "DELETE").length, 1);
  assert.equal(client.verifies(), 1);
});

void test("unsafe auth evidence during diagnostics prevents a mutation", async () => {
  const client = new Client();
  const evidence = deferred<unknown>();
  const started = deferred<void>();
  client.responder = (input) => {
    if (input.path === "iserver/auth/status")
      return {
        authenticated: true,
        connected: true,
        competing: false,
      };
    if (input.path === "iserver/accounts") {
      started.resolve();
      return evidence.promise;
    }
    if (input.path === "tickle")
      return {
        iserver: {
          authStatus: {
            authenticated: false,
            connected: false,
            competing: false,
          },
        },
      };
    return undefined;
  };
  const mutation = client.cancelEquityOrder({ accountId: account, orderId: "test-order" });
  await started.promise;
  await client.tickle();
  evidence.resolve({ accounts: [account], selectedAccount: account, isPaper: true });
  await assert.rejects(mutation, /safely authenticated/);
  assert.equal(
    client.calls.some((call) => call.method === "DELETE"),
    false
  );
});

void test("unsafe auth evidence during account preparation prevents a mutation", async () => {
  const client = new Client();
  const switchEvidence = deferred<unknown>();
  const switching = deferred<void>();
  client.responder = (input) => {
    if (input.path === "iserver/auth/status")
      return {
        authenticated: true,
        connected: true,
        competing: false,
      };
    if (input.path === "iserver/accounts")
      return {
        accounts: [account, otherAccount],
        selectedAccount: otherAccount,
        isPaper: true,
      };
    if (input.path === "iserver/account") {
      switching.resolve();
      return switchEvidence.promise;
    }
    if (input.path === "tickle")
      return {
        iserver: {
          authStatus: {
            authenticated: false,
            connected: false,
            competing: false,
          },
        },
      };
    return undefined;
  };
  const mutation = client.cancelEquityOrder({ accountId: account, orderId: "test-order" });
  await switching.promise;
  await client.tickle();
  switchEvidence.resolve({ set: true, acctId: account });
  await assert.rejects(mutation);
  assert.equal(
    client.calls.some((call) => call.method === "DELETE"),
    false
  );
});

void test("client uses method-aware documented pacing for each endpoint", async () => {
  const cases: Array<[Input, number]> = [
    [{ path: "iserver/account/orders" }, 5_000],
    [{ path: "iserver/account/trades" }, 5_000],
    [{ path: "portfolio/accounts" }, 5_000],
    [{ path: "iserver/marketdata/snapshot" }, 100],
    [{ path: "iserver/marketdata/history" }, 1_200],
    [{ path: "tickle", method: "POST" }, 1_000],
  ];
  for (const [input, interval] of cases) {
    const client = new Client();
    const starts: number[] = [];
    client.responder = () => {
      starts.push(client.clock);
      return {};
    };
    await client.endpoint(input);
    await client.endpoint(input);
    assert.equal(starts[1]! - starts[0]!, interval, input.path);
  }
  const client = new Client();
  const before = client.clock;
  await client.endpoint({ path: `iserver/account/${account}/orders`, method: "POST" });
  await client.endpoint({ path: `iserver/account/${account}/orders`, method: "POST" });
  assert.equal(client.clock - before, 100);
});

void test("transactions fail fast until their exact 15-minute boundary", async () => {
  const client = new Client();
  const input = { path: "pa/transactions", method: "POST" };
  await client.endpoint(input);
  client.clock = 899_999;
  await assert.rejects(client.endpoint(input), (error: unknown) => {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "IBKR_THROTTLED" &&
      "retryAfterMs" in error &&
      error.retryAfterMs === 1
    );
  });
  assert.equal(client.clock, 899_999);
  client.clock = 900_000;
  await client.endpoint(input);
  assert.equal(client.calls.length, 2);
});

void test("a status read passes a queued paced trades read for the confirmed account", async () => {
  let now = 0;
  const waits: Array<{ at: number; resolve: () => void }> = [];
  const client = new Client({
    requestScheduler: {
      now: () => now,
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          waits.push({ at: now + ms, resolve });
        }),
    },
  });
  const flush = async () => {
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const wait of [...waits])
      if (wait.at <= now) {
        waits.splice(waits.indexOf(wait), 1);
        wait.resolve();
      }
    await flush();
  };
  const initial = client.getDerivativeExecutions({ accountId: account });
  await flush();
  await advance(100);
  await initial;
  const paced = client.getDerivativeExecutions({ accountId: account });
  const status = client.getDerivativeOrderStatus(account, "test-status");
  const statusRejected = assert.rejects(status); // Empty mock response fails identity after dispatch.
  await flush();
  await advance(100);
  await statusRejected;
  assert.equal(client.calls.filter((call) => call.path === "iserver/account/trades").length, 1);
  assert.ok(client.calls.some((call) => call.path.includes("/order/status/")));
  // Missing account identity invalidates confirmation, so the queued trades read fails closed.
  const pacedRejected = assert.rejects(paced, /selection changed/);
  await advance(4_900);
  await pacedRejected;
});

void test("not-found and parse failures preserve selection for concurrent siblings", async () => {
  for (const failure of ["not-found", "parse", "400", "404"]) {
    const client = new Client();
    const trades = deferred<unknown>();
    const started = deferred<void>();
    client.responder = (input) => {
      if (input.path === "iserver/account/trades") {
        started.resolve();
        return trades.promise;
      }
      if (input.path === "iserver/account/orders")
        return failure === "parse" ? { orders: [] } : { snapshot: true, orders: [] };
      if (input.path.includes("/order/status/"))
        return Promise.reject(
          new IbkrHttpError("Unknown order", Number(failure), {
            status: Number(failure),
            body: "Unknown order",
            retryAfter: null,
          })
        );
      return undefined;
    };
    const sibling = client.getDerivativeExecutions({ accountId: account });
    await started.promise;
    if (failure === "not-found") {
      await assert.rejects(
        client.findDerivativeOrder({ accountId: account, clientOrderId: "test-missing" }),
        /not found/
      );
    } else if (failure === "parse") {
      await assert.rejects(client.listActiveDerivativeOrders(account), /incomplete/);
    } else {
      await assert.rejects(client.getDerivativeOrderStatus(account, "test-missing"));
    }
    trades.resolve([]);
    await sibling;
    await client.getDerivativeExecutions({ accountId: account });
    assert.equal(client.verifies(), 1, failure);
  }
});

void test("401 and explicit account failures invalidate selection", async () => {
  for (const evidence of ["401", "wrong-account", "missing-account", "400-account"]) {
    const client = new Client();
    client.responder = (input) => {
      if (input.path.includes("/order/status/")) {
        if (evidence === "401" || evidence === "400-account") {
          const status = evidence === "401" ? 401 : 400;
          return Promise.reject(
            new IbkrHttpError("Account selection unavailable", status, {
              status,
              body: "Account selection unavailable",
              retryAfter: null,
            })
          );
        }
        return evidence === "wrong-account" ? { account: otherAccount } : {};
      }
      return undefined;
    };
    await client.getDerivativeExecutions({ accountId: account });
    await assert.rejects(client.getDerivativeOrderStatus(account, "test-order"));
    await client.getDerivativeExecutions({ accountId: account });
    assert.equal(client.verifies(), 2, evidence);
  }
});

void test("conflicting execution account aliases invalidate confirmation", async () => {
  const client = new Client();
  let conflict = true;
  client.responder = (input) => {
    if (input.path === "iserver/account/trades" && conflict) {
      conflict = false;
      return [{ account, accountCode: otherAccount }];
    }
    return undefined;
  };
  assert.deepEqual(await client.getDerivativeExecutions({ accountId: account }), []);
  await client.getDerivativeExecutions({ accountId: account });
  assert.equal(client.verifies(), 2);
});
