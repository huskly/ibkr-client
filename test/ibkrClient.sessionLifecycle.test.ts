import assert from "node:assert/strict";
import test from "node:test";
import { IbkrClient, IbkrHttpError, type IbkrClientOptions } from "../src/index.js";
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

class LifecycleClient extends IbkrClient {
  readonly calls: RequestInput[] = [];
  readonly initCalls: [boolean | undefined, boolean | undefined][] = [];

  constructor(
    private readonly responder: (input: RequestInput) => unknown = () => ({}),
    options: IbkrClientOptions = {}
  ) {
    super(config, {
      ...options,
      requestScheduler: { secdefInfoMinStartIntervalMs: 0, ...options.requestScheduler },
    });
    (
      this as unknown as { raw: { init: (compete?: boolean, publish?: boolean) => Promise<void> } }
    ).raw = {
      init: (compete, publish) => {
        this.initCalls.push([compete, publish]);
        return Promise.resolve();
      },
    };
  }

  protected override sendRequest<T>(input: RequestInput): Promise<T> {
    this.calls.push(input);
    try {
      return Promise.resolve(this.responder(input) as T);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  protected override wait(_ms: number): Promise<void> {
    return Promise.resolve();
  }
}

void test("explicit initialization and renewal pass exact flags once", async () => {
  const client = new LifecycleClient();

  await client.initializeBrokerageSession({ compete: false, publish: true });
  await client.renewBrokerageSession({ compete: false, publish: false });

  assert.deepEqual(client.initCalls, [
    [false, true],
    [false, false],
  ]);
});

void test("deprecated init keeps compete=true and remains idempotent", async () => {
  const client = new LifecycleClient();

  await Promise.all([client.init(), client.init()]);

  assert.deepEqual(client.initCalls, [[true, true]]);
});

void test("initialization normalizes HTTP failures without retry", async () => {
  const rawError = Object.assign(new Error("Response status 503: unavailable"), { status: 503 });
  const client = new LifecycleClient();
  (client as unknown as { raw: { init: () => Promise<never> } }).raw = {
    init: () => {
      client.initCalls.push([false, true]);
      return Promise.reject(rawError);
    },
  };

  await assert.rejects(
    client.initializeBrokerageSession({ compete: false, publish: true }),
    IbkrHttpError
  );
  assert.equal(client.initCalls.length, 1);
});

void test("session evidence preserves complete, absent, and malformed broker fields", async () => {
  const complete = new LifecycleClient((input) =>
    input.path === "iserver/auth/status"
      ? { authenticated: true, competing: false, connected: true }
      : { accounts: ["U1", "U2"], selectedAccount: "U2", isPaper: false }
  );
  assert.deepEqual(await complete.getSessionEvidence(), {
    authenticated: true,
    competing: false,
    connected: true,
    accountIds: ["U1", "U2"],
    selectedAccountId: "U2",
    isPaper: false,
  });

  const unknown = new LifecycleClient((input) =>
    input.path === "iserver/auth/status"
      ? { authenticated: "yes", competing: 0 }
      : { accounts: ["U1", 2], selectedAccount: 7, isPaper: "false" }
  );
  assert.deepEqual(await unknown.getSessionEvidence(), {
    authenticated: null,
    competing: null,
    connected: null,
    accountIds: null,
    selectedAccountId: null,
    isPaper: null,
  });

  const empty = new LifecycleClient((input) =>
    input.path === "iserver/auth/status" ? null : { accounts: [] }
  );
  assert.deepEqual(await empty.getSessionEvidence(), {
    authenticated: null,
    competing: null,
    connected: null,
    accountIds: [],
    selectedAccountId: null,
    isPaper: null,
  });
});

void test("auth status and trading diagnostics preserve unknown safety evidence", async () => {
  const client = new LifecycleClient((input) => {
    if (input.path === "iserver/auth/status") return {};
    if (input.path === "iserver/accounts") return { accounts: ["U1"], selectedAccount: "U1" };
    throw new Error(`Unexpected request: ${input.path}`);
  });

  assert.deepEqual(await client.getAuthStatus(), {
    authenticated: null,
    competing: null,
    connected: null,
  });
  assert.deepEqual(await client.getTradingDiagnostics("U1"), {
    accountId: "U1",
    selectedAccountId: "U1",
    environment: null,
    authenticated: null,
    competingSession: null,
    marketDataAvailable: null,
    advisoryAssetPermissions: [],
  });
});

void test("tickle is a safe read and logout is a single idempotent broker attempt", async () => {
  let logoutCalls = 0;
  const failure = Object.assign(new Error("Response status 500: failed"), { status: 500 });
  const client = new LifecycleClient((input) => {
    if (input.path === "tickle") return {};
    if (input.path === "logout") {
      logoutCalls += 1;
      throw failure;
    }
    throw new Error(`Unexpected request: ${input.path}`);
  });

  await client.tickle();
  assert.deepEqual(client.calls[0], { path: "tickle", method: "POST" });
  await assert.rejects(client.logout(), IbkrHttpError);
  await assert.rejects(client.logout(), IbkrHttpError);
  assert.equal(logoutCalls, 1);
});

void test("close is local, idempotent, and prevents later lifecycle and request use", async () => {
  const client = new LifecycleClient();

  await client.close();
  await client.close();

  await assert.rejects(client.getAuthStatus(), /closed/iu);
  await assert.rejects(client.init(), /closed/iu);
  await assert.rejects(
    client.initializeBrokerageSession({ compete: false, publish: true }),
    /closed/iu
  );
  await assert.rejects(client.tickle(), /closed/iu);
  await assert.rejects(client.logout(), /closed/iu);
  assert.deepEqual(client.calls, []);
  assert.deepEqual(client.initCalls, []);
});
