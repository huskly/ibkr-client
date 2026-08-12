import assert from "node:assert/strict";
import test from "node:test";
import { IbkrRequestScheduler, IbkrRequestSchedulerError } from "../src/ibkr/requestScheduler.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

void test("scheduler bounds discovery concurrency and prioritizes execution reads", async () => {
  const first = deferred();
  const order: string[] = [];
  const scheduler = new IbkrRequestScheduler({ maxConcurrent: 1, maxDiscoveryConcurrent: 1 });

  const activeDiscovery = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY" },
    async () => {
      order.push("discovery-1-start");
      await first.promise;
      order.push("discovery-1-end");
      return 1;
    }
  );
  const queuedDiscovery = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY" },
    async () => {
      order.push("discovery-2");
      return 2;
    }
  );
  const status = scheduler.schedule(
    { endpoint: "order/status", priority: "EXECUTION" },
    async () => {
      order.push("status");
      return 3;
    }
  );

  first.resolve();
  assert.deepEqual(await Promise.all([activeDiscovery, queuedDiscovery, status]), [1, 2, 3]);
  assert.deepEqual(order, ["discovery-1-start", "discovery-1-end", "status", "discovery-2"]);
  assert.equal(scheduler.metrics.maximumConcurrent, 1);
  assert.equal(scheduler.metrics.maximumDiscoveryConcurrent, 1);
});

void test("a non-error abort reason rejects with safe Error evidence", async () => {
  const controller = new AbortController();
  controller.abort("caller stopped");
  const scheduler = new IbkrRequestScheduler();

  await assert.rejects(
    scheduler.schedule(
      { endpoint: "secdef/info", priority: "DISCOVERY", signal: controller.signal },
      async () => "must not start"
    ),
    (error: unknown) => error instanceof Error && error.cause === "caller stopped"
  );
});

void test("default secdef pacing prevents starts that are too close together", async () => {
  let now = 0;
  const starts: number[] = [];
  const scheduler = new IbkrRequestScheduler({
    maxConcurrent: 4,
    now: () => now,
    sleep: async (ms) => {
      await Promise.resolve();
      now += ms;
    },
  });

  const definitions = Array.from({ length: 4 }, (_value, index) =>
    scheduler.schedule(
      { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
      async () => {
        const previousStart = starts.at(-1);
        if (previousStart !== undefined && now - previousStart < 250) {
          throw new Error("429: starts were too close together");
        }
        starts.push(now);
        return index;
      }
    )
  );

  assert.deepEqual(await Promise.all(definitions), [0, 1, 2, 3]);
  assert.deepEqual(starts, [0, 250, 500, 750]);
  assert.equal(scheduler.metrics.maximumSecdefInfoConcurrent, 1);
});

void test("configured secdef lane enforces concurrency and minimum start spacing", async () => {
  const gates = Array.from({ length: 7 }, () => deferred());
  let active = 0;
  let maximum = 0;
  let calls = 0;
  let now = 0;
  const starts: number[] = [];
  const order: string[] = [];
  const scheduler = new IbkrRequestScheduler({
    maxConcurrent: 4,
    maxDiscoveryConcurrent: 1,
    maxSecdefInfoConcurrent: 3,
    secdefInfoMinStartIntervalMs: 100,
    now: () => now,
    sleep: async (ms) => {
      await Promise.resolve();
      now += ms;
    },
  });

  const definitions = gates.map((gate, index) =>
    scheduler.schedule(
      { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
      async () => {
        calls += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        starts.push(now);
        order.push(`info-${String(index)}-start`);
        await gate.promise;
        active -= 1;
        return index;
      }
    )
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  assert.deepEqual(starts, [0, 100, 200]);
  const execution = scheduler.schedule(
    { endpoint: "order/status", priority: "EXECUTION" },
    async () => {
      order.push("execution");
      return "execution";
    }
  );
  gates[0]?.resolve();
  await execution;
  assert.equal(order[3], "execution");
  for (const gate of gates) gate.resolve();
  assert.deepEqual(await Promise.all(definitions), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(calls, 7);
  assert.equal(maximum, 3);
  assert.equal(scheduler.metrics.maximumSecdefInfoConcurrent, 3);
});

void test("one secdef throttle coordinates endpoint backoff without blocking execution", async () => {
  const backoff = deferred();
  const sleeps: number[] = [];
  let now = 0;
  const attempts = [0, 0, 0];
  const order: string[] = [];
  const telemetry: unknown[] = [];
  const scheduler = new IbkrRequestScheduler({
    maxConcurrent: 3,
    maxSecdefInfoConcurrent: 1,
    secdefInfoMinStartIntervalMs: 100,
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      return backoff.promise.then(() => {
        now += ms;
      });
    },
    random: () => 0,
    classifyError: (error) =>
      error instanceof Error && error.message === "429"
        ? { kind: "THROTTLED", retryAfterMs: 1_000 }
        : { kind: "OTHER" },
    onTelemetry: (event) => telemetry.push(event),
  });

  const definitions = attempts.map((_attempt, index) =>
    scheduler.schedule(
      { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
      async () => {
        attempts[index] = (attempts[index] ?? 0) + 1;
        order.push(`info-${String(index)}`);
        if (index === 0 && attempts[index] === 1) throw new Error("429");
        return index;
      }
    )
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(attempts, [1, 0, 0]);
  const execution = scheduler.schedule(
    { endpoint: "account/order/status", priority: "EXECUTION" },
    async () => {
      order.push("execution");
      return "execution";
    }
  );
  assert.equal(await execution, "execution");
  assert.deepEqual(attempts, [1, 0, 0], "queued definitions share the endpoint wait");
  assert.deepEqual(sleeps, [1_000]);
  assert.deepEqual(telemetry, [
    {
      event: "THROTTLED",
      endpoint: "secdef/info",
      attempt: 1,
      delayMs: 1_000,
      effectiveMinStartIntervalMs: 1_000,
    },
    {
      event: "SECDEF_INFO_PACING",
      endpoint: "secdef/info",
      attempt: 0,
      delayMs: 1_000,
      effectiveMinStartIntervalMs: 1_000,
    },
  ]);

  backoff.resolve();
  assert.deepEqual(await Promise.all(definitions), [0, 1, 2]);
  assert.deepEqual(attempts, [2, 1, 1], "the retry count is unchanged and only 429 is retried");
  assert.equal(order[1], "execution");
});

void test("a secdef throttle paces queued work when retries are disabled", async () => {
  const pacingWait = deferred();
  const sleeps: number[] = [];
  let now = 0;
  let queuedCalls = 0;
  const scheduler = new IbkrRequestScheduler({
    maxConcurrent: 2,
    maxRetries: 0,
    secdefInfoMinStartIntervalMs: 100,
    jitterRatio: 0,
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      return pacingWait.promise.then(() => {
        now += ms;
      });
    },
    classifyError: () => ({ kind: "THROTTLED", retryAfterMs: 60_000 }),
  });

  const throttled = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
    async () => {
      throw new Error("throttled");
    }
  );
  const queued = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
    async () => {
      queuedCalls += 1;
      return "queued";
    }
  );

  await assert.rejects(
    throttled,
    (error: unknown) =>
      error instanceof IbkrRequestSchedulerError &&
      error.code === "IBKR_THROTTLED" &&
      error.retryAfterMs === 60_000
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(queuedCalls, 0);
  pacingWait.resolve();
  assert.equal(await queued, "queued");
  assert.deepEqual(sleeps, [60_000]);
});

void test("a final secdef throttle extends endpoint pacing before exhaustion", async () => {
  const waits: Array<{ delayMs: number; gate: ReturnType<typeof deferred> }> = [];
  let now = 0;
  let throttledAttempts = 0;
  let queuedCalls = 0;
  const scheduler = new IbkrRequestScheduler({
    maxConcurrent: 2,
    maxRetries: 1,
    secdefInfoMinStartIntervalMs: 50,
    jitterRatio: 0,
    now: () => now,
    sleep: (delayMs) => {
      const gate = deferred();
      waits.push({ delayMs, gate });
      return gate.promise.then(() => {
        now += delayMs;
      });
    },
    classifyError: () => ({
      kind: "THROTTLED",
      retryAfterMs: throttledAttempts === 1 ? 100 : 1_000,
    }),
  });

  const throttled = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
    async () => {
      throttledAttempts += 1;
      throw new Error("throttled");
    }
  );
  const queued = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
    async () => {
      queuedCalls += 1;
      return "queued";
    }
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(waits[0]?.delayMs, 100);
  waits[0]?.gate.resolve();
  await assert.rejects(throttled, IbkrRequestSchedulerError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(queuedCalls, 0);
  assert.equal(waits[1]?.delayMs, 1_000);
  waits[1]?.gate.resolve();
  assert.equal(await queued, "queued");
  assert.equal(throttledAttempts, 2);
});

void test("a rejected secdef pacing sleep rejects queued definitions once", async () => {
  const sleepError = new Error("pacing sleep failed");
  const strandedSleep = deferred();
  let sleepCalls = 0;
  const scheduler = new IbkrRequestScheduler({
    secdefInfoMinStartIntervalMs: 250,
    now: () => 0,
    sleep: () => {
      sleepCalls += 1;
      return sleepCalls === 1 ? Promise.reject(sleepError) : strandedSleep.promise;
    },
  });

  const first = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
    async () => "first"
  );
  const queued = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
    async () => "must not run"
  );

  assert.equal(await first, "first");
  await assert.rejects(queued, (error: unknown) => error === sleepError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sleepCalls, 1);
});

void test("temporary block opens a bounded circuit and rejects queued discovery", async () => {
  let queuedCalls = 0;
  const scheduler = new IbkrRequestScheduler({
    maxConcurrent: 1,
    now: () => 10_000,
    circuitDurationMs: 60_000,
    classifyError: (error) =>
      error instanceof Error && error.message === "blocked"
        ? { kind: "TEMPORARILY_BLOCKED" }
        : { kind: "OTHER" },
  });

  const blocked = scheduler.schedule({ endpoint: "secdef/search", priority: "DISCOVERY" }, () =>
    Promise.reject(new Error("blocked"))
  );
  const queued = scheduler.schedule({ endpoint: "secdef/info", priority: "DISCOVERY" }, () => {
    queuedCalls += 1;
    return Promise.resolve("unexpected");
  });

  for (const result of await Promise.allSettled([blocked, queued])) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof IbkrRequestSchedulerError);
      assert.equal(result.reason.code, "IBKR_TEMPORARILY_BLOCKED");
      assert.equal(result.reason.retryAfterMs, 60_000);
    }
  }
  assert.equal(queuedCalls, 0);
  await assert.rejects(
    () =>
      scheduler.schedule({ endpoint: "order/status", priority: "EXECUTION" }, () =>
        Promise.resolve()
      ),
    (error: unknown) =>
      error instanceof IbkrRequestSchedulerError && error.code === "IBKR_TEMPORARILY_BLOCKED"
  );
});

void test("server retries are opt-in and use a per-job bounded delay", async () => {
  const sleeps: number[] = [];
  const telemetry: unknown[] = [];
  let attempts = 0;
  const scheduler = new IbkrRequestScheduler({
    maxRetries: 1,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 125,
    jitterRatio: 1,
    random: () => 99,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    classifyError: () => ({ kind: "SERVER_ERROR" }),
    onTelemetry: (event) => telemetry.push(event),
  });

  const result = await scheduler.schedule(
    {
      endpoint: "iserver/marketdata",
      priority: "STANDARD",
      retryServerErrors: true,
    },
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("server");
      return "history";
    }
  );

  assert.equal(result, "history");
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [125]);
  assert.deepEqual(telemetry, [
    { event: "SERVER_RETRY", endpoint: "iserver/marketdata", attempt: 1, delayMs: 125 },
  ]);
});

void test("server errors are not retried without explicit read opt-in", async () => {
  let attempts = 0;
  const finalError = new Error("final server evidence");
  const scheduler = new IbkrRequestScheduler({
    classifyError: () => ({ kind: "SERVER_ERROR" }),
    sleep: () => Promise.reject(new Error("must not sleep")),
  });

  await assert.rejects(
    () =>
      scheduler.schedule({ endpoint: "account/orders", priority: "EXECUTION" }, async () => {
        attempts += 1;
        throw finalError;
      }),
    (error: unknown) => error === finalError
  );
  assert.equal(attempts, 1);
});

void test("scheduler rejects retry settings that are not bounded", () => {
  assert.throws(() => new IbkrRequestScheduler({ maxRetries: -1 }), /retry limits/);
  assert.throws(
    () => new IbkrRequestScheduler({ retryBaseDelayMs: 500, retryMaxDelayMs: 100 }),
    /retry limits/
  );
  assert.throws(() => new IbkrRequestScheduler({ jitterRatio: 1.1 }), /retry limits/);
  assert.throws(
    () => new IbkrRequestScheduler({ secdefInfoMinStartIntervalMs: -1 }),
    /pacing limits/
  );
});

void test("explicit Retry-After is not clamped by the local exponential cap", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const scheduler = new IbkrRequestScheduler({
    maxRetries: 1,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 500,
    jitterRatio: 0,
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    classifyError: () => ({ kind: "THROTTLED", retryAfterMs: 60_000 }),
  });

  assert.equal(
    await scheduler.schedule({ endpoint: "read", priority: "STANDARD" }, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("throttled");
      return "ok";
    }),
    "ok"
  );
  assert.deepEqual(sleeps, [60_000]);
});

void test("a sleeping server retry fails behind a circuit opened by another request", async () => {
  const retrySleep = deferred();
  let historyAttempts = 0;
  const scheduler = new IbkrRequestScheduler({
    maxConcurrent: 1,
    now: () => 0,
    sleep: () => retrySleep.promise,
    classifyError: (error) => {
      if (error instanceof Error && error.message === "server") return { kind: "SERVER_ERROR" };
      if (error instanceof Error && error.message === "blocked") {
        return { kind: "TEMPORARILY_BLOCKED" };
      }
      return { kind: "OTHER" };
    },
  });

  const history = scheduler.schedule(
    {
      endpoint: "iserver/marketdata",
      priority: "STANDARD",
      retryServerErrors: true,
    },
    async () => {
      historyAttempts += 1;
      if (historyAttempts === 1) throw new Error("server");
      return "must not send";
    }
  );
  const blocked = scheduler.schedule({ endpoint: "secdef/search", priority: "DISCOVERY" }, () =>
    Promise.reject(new Error("blocked"))
  );

  await assert.rejects(blocked, /temporarily blocked/);
  retrySleep.resolve();
  await assert.rejects(
    history,
    (error: unknown) =>
      error instanceof IbkrRequestSchedulerError && error.code === "IBKR_TEMPORARILY_BLOCKED"
  );
  assert.equal(historyAttempts, 1);
});

void test("telemetry callback failures cannot strand a server retry", async () => {
  let attempts = 0;
  const scheduler = new IbkrRequestScheduler({
    maxRetries: 1,
    sleep: async () => undefined,
    classifyError: () => ({ kind: "SERVER_ERROR" }),
    onTelemetry: () => {
      throw new Error("observer failed");
    },
  });

  const request = scheduler.schedule(
    {
      endpoint: "iserver/marketdata",
      priority: "STANDARD",
      retryServerErrors: true,
    },
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("server");
      return "ok";
    }
  );
  const result = await Promise.race([
    request,
    new Promise<string>((resolve) => setTimeout(() => resolve("stranded"), 25)),
  ]);
  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

void test("rejected asynchronous telemetry cannot create an unhandled retry failure", async () => {
  let attempts = 0;
  const scheduler = new IbkrRequestScheduler({
    maxRetries: 1,
    sleep: async () => undefined,
    classifyError: () => ({ kind: "SERVER_ERROR" }),
    onTelemetry: async () => {
      throw new Error("async observer failed");
    },
  });

  assert.equal(
    await scheduler.schedule(
      {
        endpoint: "iserver/marketdata",
        priority: "STANDARD",
        retryServerErrors: true,
      },
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("server");
        return "ok";
      }
    ),
    "ok"
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
});
