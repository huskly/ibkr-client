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

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function clock() {
  let now = 0;
  const waits: Array<{ at: number; resolve: () => void }> = [];
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleeps,
    sleep: (ms: number) => {
      sleeps.push(ms);
      const gate = deferred();
      waits.push({ at: now + ms, resolve: gate.resolve });
      return gate.promise;
    },
    async advance(ms: number) {
      now += ms;
      for (const wait of [...waits]) {
        if (wait.at <= now) {
          waits.splice(waits.indexOf(wait), 1);
          wait.resolve();
        }
      }
      await flush();
    },
    async finish<T>(promise: Promise<T>): Promise<T> {
      let settled = false;
      void promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      for (let i = 0; i < 100 && !settled; i += 1) {
        await flush();
        if (settled) break;
        assert.ok(waits.length > 0, "request must have a pending controlled wait");
        await this.advance(Math.max(0, Math.min(...waits.map((wait) => wait.at)) - now));
      }
      assert.ok(settled, "controlled request settled");
      return promise;
    },
  };
}

void test("global starts wait until exactly 100 ms, including different endpoints", async () => {
  const time = clock();
  const starts: number[] = [];
  const scheduler = new IbkrRequestScheduler({ ...time });
  const first = scheduler.schedule({ endpoint: "a", priority: "STANDARD" }, async () => {
    starts.push(time.now());
  });
  const second = scheduler.schedule({ endpoint: "b", priority: "STANDARD" }, async () => {
    starts.push(time.now());
  });
  await flush();
  assert.deepEqual(starts, [0]);
  await time.advance(99);
  assert.deepEqual(starts, [0]);
  await time.advance(1);
  await Promise.all([first, second]);
  assert.deepEqual(starts, [0, 100]);
});

void test("keyed pacing waits at the exact boundary and does not block other keys", async () => {
  const time = clock();
  const starts: Array<[string, number]> = [];
  const scheduler = new IbkrRequestScheduler({ ...time });
  const schedule = (name: string, key: string) =>
    scheduler.schedule(
      { endpoint: name, priority: "STANDARD", pacing: { key, minStartIntervalMs: 5_000 } },
      async () => {
        starts.push([name, time.now()]);
      }
    );
  const first = schedule("first", "shared");
  const same = schedule("different-path", "shared");
  await flush();
  const independent = schedule("first", "independent");
  await time.advance(100);
  await independent;
  assert.deepEqual(starts, [
    ["first", 0],
    ["first", 100],
  ]);
  await time.advance(4_899);
  assert.equal(starts.length, 2);
  await time.advance(1);
  await Promise.all([first, same]);
  assert.deepEqual(starts[2], ["different-path", 5_000]);
});

void test("long endpoint pacing fails fast, including jobs queued before the first start", async () => {
  const time = clock();
  const gate = deferred();
  const scheduler = new IbkrRequestScheduler({ ...time, maxConcurrent: 1 });
  const active = scheduler.schedule({ endpoint: "hold", priority: "STANDARD" }, () => gate.promise);
  let calls = 0;
  const options = {
    endpoint: "slow",
    priority: "STANDARD" as const,
    pacing: { key: "slow", minStartIntervalMs: 60_000 },
  };
  const first = scheduler.schedule(options, async () => {
    calls += 1;
  });
  const second = scheduler.schedule(options, async () => {
    calls += 1;
  });
  const rejected = assert.rejects(
    second,
    (error: unknown) =>
      error instanceof IbkrRequestSchedulerError &&
      error.code === "IBKR_THROTTLED" &&
      error.endpoint === "slow" &&
      error.retryAfterMs === 60_000
  );
  gate.resolve();
  await flush();
  await time.advance(100);
  await Promise.all([active, first, rejected]);
  assert.equal(calls, 1);
  assert.deepEqual(time.sleeps, [100]);
  await time.advance(59_999);
  await assert.rejects(
    scheduler.schedule(options, async () => {
      calls += 1;
    }),
    (error: unknown) => error instanceof IbkrRequestSchedulerError && error.retryAfterMs === 1
  );
  await time.advance(1);
  await scheduler.schedule(options, async () => {
    calls += 1;
  });
  assert.equal(calls, 2);
});

void test("scheduler bounds discovery concurrency and prioritizes execution reads", async () => {
  const time = clock();
  const gate = deferred();
  const order: string[] = [];
  const scheduler = new IbkrRequestScheduler({ ...time, maxConcurrent: 1 });
  const first = scheduler.schedule({ endpoint: "discovery", priority: "DISCOVERY" }, async () => {
    order.push("first");
    await gate.promise;
  });
  const second = scheduler.schedule({ endpoint: "discovery", priority: "DISCOVERY" }, async () => {
    order.push("second");
  });
  const execution = scheduler.schedule({ endpoint: "status", priority: "EXECUTION" }, async () => {
    order.push("execution");
  });
  gate.resolve();
  await time.finish(Promise.all([first, second, execution]));
  assert.deepEqual(order, ["first", "execution", "second"]);
  assert.equal(scheduler.metrics.maximumConcurrent, 1);
  assert.equal(scheduler.metrics.maximumDiscoveryConcurrent, 1);
});

void test("default secdef pacing preserves 250 ms spacing", async () => {
  const time = clock();
  const starts: number[] = [];
  const scheduler = new IbkrRequestScheduler({ ...time });
  const jobs = Array.from({ length: 4 }, () =>
    scheduler.schedule(
      { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
      async () => {
        starts.push(time.now());
      }
    )
  );
  await time.finish(Promise.all(jobs));
  assert.deepEqual(starts, [0, 250, 500, 750]);
  assert.equal(scheduler.metrics.maximumSecdefInfoConcurrent, 1);
});

void test("configured secdef lane bounds concurrency and exact spacing", async () => {
  const time = clock();
  const gates = Array.from({ length: 4 }, () => deferred());
  const starts: number[] = [];
  const scheduler = new IbkrRequestScheduler({
    ...time,
    maxConcurrent: 4,
    maxSecdefInfoConcurrent: 3,
    secdefInfoMinStartIntervalMs: 100,
  });
  const jobs = gates.map((gate) =>
    scheduler.schedule(
      { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
      async () => {
        starts.push(time.now());
        await gate.promise;
      }
    )
  );
  await flush();
  await time.advance(100);
  await time.advance(99);
  assert.deepEqual(starts, [0, 100]);
  await time.advance(1);
  assert.deepEqual(starts, [0, 100, 200]);
  await time.advance(100);
  assert.equal(starts.length, 3);
  gates[0]?.resolve();
  await flush();
  assert.deepEqual(starts, [0, 100, 200, 300]);
  for (const gate of gates) gate.resolve();
  await Promise.all(jobs);
  assert.equal(scheduler.metrics.maximumSecdefInfoConcurrent, 3);
});

void test("secdef 429 adapts endpoint pacing without blocking execution", async () => {
  const time = clock();
  const starts: Array<[string, number]> = [];
  const telemetry: unknown[] = [];
  let attempts = 0;
  const scheduler = new IbkrRequestScheduler({
    ...time,
    jitterRatio: 0,
    classifyError: () => ({ kind: "THROTTLED", retryAfterMs: 1_000 }),
    onTelemetry: (event) => telemetry.push(event),
  });
  const first = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
    async () => {
      starts.push(["info", time.now()]);
      attempts += 1;
      if (attempts === 1) throw new Error("429");
    }
  );
  await flush();
  const execution = scheduler.schedule({ endpoint: "status", priority: "EXECUTION" }, async () => {
    starts.push(["execution", time.now()]);
  });
  await time.advance(100);
  await execution;
  assert.equal(attempts, 1);
  await time.advance(899);
  assert.equal(attempts, 1);
  await time.advance(1);
  await first;
  assert.deepEqual(starts, [
    ["info", 0],
    ["execution", 100],
    ["info", 1_000],
  ]);
  assert.ok(
    telemetry.some(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "effectiveMinStartIntervalMs" in event &&
        event.effectiveMinStartIntervalMs === 1_000
    )
  );
});

void test("final secdef throttle retains long adaptive pacing for queued reads", async () => {
  const time = clock();
  let calls = 0;
  const scheduler = new IbkrRequestScheduler({
    ...time,
    maxRetries: 0,
    jitterRatio: 0,
    classifyError: () => ({ kind: "THROTTLED", retryAfterMs: 60_000 }),
  });
  const failed = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
    async () => {
      throw new Error("429");
    }
  );
  const rejected = assert.rejects(
    failed,
    (error: unknown) => error instanceof IbkrRequestSchedulerError && error.retryAfterMs === 60_000
  );
  const queued = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
    async () => {
      calls += 1;
    }
  );
  await rejected;
  await flush();
  assert.equal(calls, 0);
  assert.deepEqual(time.sleeps, [60_000]);
  await time.advance(60_000);
  await queued;
  assert.equal(calls, 1);
});

void test("broker Retry-After keeps the existing retry without local clamping", async () => {
  const time = clock();
  let attempts = 0;
  const scheduler = new IbkrRequestScheduler({
    ...time,
    maxRetries: 1,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 500,
    jitterRatio: 0,
    classifyError: () => ({ kind: "THROTTLED", retryAfterMs: 60_000 }),
  });
  const request = scheduler.schedule({ endpoint: "read", priority: "STANDARD" }, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("429");
    return "ok";
  });
  assert.equal(await time.finish(request), "ok");
  assert.deepEqual(time.sleeps, [60_000]);
  assert.equal(attempts, 2);
});

void test("writes are not retried on throttle or server errors", async () => {
  for (const kind of ["THROTTLED", "SERVER_ERROR"] as const) {
    const time = clock();
    let attempts = 0;
    const evidence = new Error("write failed");
    const scheduler = new IbkrRequestScheduler({ ...time, classifyError: () => ({ kind }) });
    await assert.rejects(
      scheduler.schedule(
        { endpoint: "orders", priority: "EXECUTION", retryable: false, retryServerErrors: false },
        async () => {
          attempts += 1;
          throw evidence;
        }
      ),
      (error: unknown) =>
        kind === "SERVER_ERROR"
          ? error === evidence
          : error instanceof IbkrRequestSchedulerError && error.cause === evidence
    );
    assert.equal(attempts, 1);
    assert.deepEqual(time.sleeps, []);
  }
});

void test("server retries are opt-in with bounded per-job delay", async () => {
  const time = clock();
  let attempts = 0;
  const scheduler = new IbkrRequestScheduler({
    ...time,
    maxRetries: 1,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 125,
    jitterRatio: 1,
    random: () => 99,
    classifyError: () => ({ kind: "SERVER_ERROR" }),
  });
  const request = scheduler.schedule(
    { endpoint: "history", priority: "STANDARD", retryServerErrors: true },
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("server");
      return "ok";
    }
  );
  assert.equal(await time.finish(request), "ok");
  assert.equal(attempts, 2);
  assert.deepEqual(time.sleeps, [125]);
});

void test("temporary block opens the circuit and rejects queued work", async () => {
  const time = clock();
  let calls = 0;
  const scheduler = new IbkrRequestScheduler({
    ...time,
    maxConcurrent: 1,
    classifyError: () => ({ kind: "TEMPORARILY_BLOCKED" }),
  });
  const failed = scheduler.schedule({ endpoint: "blocked", priority: "STANDARD" }, async () => {
    throw new Error("blocked");
  });
  const queued = scheduler.schedule({ endpoint: "queued", priority: "STANDARD" }, async () => {
    calls += 1;
  });
  for (const result of await Promise.allSettled([failed, queued])) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected")
      assert.ok(
        result.reason instanceof IbkrRequestSchedulerError &&
          result.reason.code === "IBKR_TEMPORARILY_BLOCKED"
      );
  }
  assert.equal(calls, 0);
  await assert.rejects(
    scheduler.schedule({ endpoint: "new", priority: "STANDARD" }, async () => undefined),
    /circuit is open/
  );
});

void test("sleeping server retry fails behind a circuit opened by another request", async () => {
  const time = clock();
  let attempts = 0;
  const scheduler = new IbkrRequestScheduler({
    ...time,
    maxConcurrent: 1,
    jitterRatio: 0,
    classifyError: (error) =>
      error instanceof Error && error.message === "server"
        ? { kind: "SERVER_ERROR" }
        : { kind: "TEMPORARILY_BLOCKED" },
  });
  const history = scheduler.schedule(
    { endpoint: "history", priority: "STANDARD", retryServerErrors: true },
    async () => {
      attempts += 1;
      throw new Error("server");
    }
  );
  const rejected = assert.rejects(history, /circuit is open/);
  const blocked = scheduler.schedule({ endpoint: "blocked", priority: "DISCOVERY" }, async () => {
    throw new Error("blocked");
  });
  const blockRejected = assert.rejects(blocked, /temporarily blocked/);
  await flush();
  await time.advance(100);
  await blockRejected;
  await time.advance(150);
  await rejected;
  assert.equal(attempts, 1);
});

void test("aborts preserve error evidence and remove queued jobs", async () => {
  const time = clock();
  const scheduler = new IbkrRequestScheduler({ ...time });
  const controller = new AbortController();
  controller.abort("caller stopped");
  await assert.rejects(
    scheduler.schedule(
      { endpoint: "pre", priority: "STANDARD", signal: controller.signal },
      async () => undefined
    ),
    (error: unknown) => error instanceof Error && error.cause === "caller stopped"
  );
  await scheduler.schedule({ endpoint: "first", priority: "STANDARD" }, async () => undefined);
  const queuedController = new AbortController();
  const queued = scheduler.schedule(
    { endpoint: "queued", priority: "STANDARD", signal: queuedController.signal },
    async () => {
      assert.fail("aborted task must not run");
    }
  );
  const reason = new Error("stopped");
  queuedController.abort(reason);
  await assert.rejects(queued, (error: unknown) => error === reason);
});

void test("rejected pacing sleep settles queued work once", async () => {
  const error = new Error("sleep failed");
  let terminalCalls = 0;
  const scheduler = new IbkrRequestScheduler({
    now: () => 0,
    sleep: async () => {
      throw error;
    },
  });
  const first = scheduler.schedule(
    { endpoint: "first", priority: "STANDARD" },
    async () => undefined
  );
  const queued = scheduler.schedule(
    {
      endpoint: "queued",
      priority: "STANDARD",
      onTerminalFailure: () => {
        terminalCalls += 1;
      },
    },
    async () => undefined
  );
  await first;
  await assert.rejects(queued, (actual: unknown) => actual === error);
  assert.equal(terminalCalls, 1);
});

void test("telemetry observer failures cannot strand retries", async () => {
  for (const asynchronous of [false, true]) {
    const time = clock();
    let attempts = 0;
    const scheduler = new IbkrRequestScheduler({
      ...time,
      maxRetries: 1,
      classifyError: () => ({ kind: "SERVER_ERROR" }),
      onTelemetry: () => {
        if (asynchronous) return Promise.reject(new Error("observer"));
        throw new Error("observer");
      },
    });
    const request = scheduler.schedule(
      { endpoint: "history", priority: "STANDARD", retryServerErrors: true },
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("server");
        return "ok";
      }
    );
    assert.equal(await time.finish(request), "ok");
    assert.equal(attempts, 2);
  }
});

void test("scheduler rejects unbounded settings", () => {
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

void test("long pacing rejects concurrent queued jobs immediately after an eligible start", async () => {
  const time = clock();
  const scheduler = new IbkrRequestScheduler({ ...time });
  await scheduler.schedule({ endpoint: "initial", priority: "STANDARD" }, async () => undefined);
  const options = {
    endpoint: "slow",
    priority: "STANDARD" as const,
    pacing: { key: "slow", minStartIntervalMs: 60_000 },
  };
  let calls = 0;
  const first = scheduler.schedule(options, async () => {
    calls += 1;
  });
  const second = scheduler.schedule(options, async () => {
    calls += 1;
  });
  const rejected = assert.rejects(
    second,
    (error: unknown) => error instanceof IbkrRequestSchedulerError && error.retryAfterMs === 60_000
  );
  await time.advance(100);
  await Promise.all([first, rejected]);
  assert.equal(calls, 1);
  assert.deepEqual(time.sleeps, [100]);
});

void test("final secdef throttle extends pacing before retry exhaustion", async () => {
  const time = clock();
  let attempts = 0;
  let queuedCalls = 0;
  const scheduler = new IbkrRequestScheduler({
    ...time,
    maxRetries: 1,
    jitterRatio: 0,
    secdefInfoMinStartIntervalMs: 50,
    classifyError: () => ({ kind: "THROTTLED", retryAfterMs: attempts === 1 ? 100 : 1_000 }),
  });
  const failed = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
    async () => {
      attempts += 1;
      throw new Error("throttle");
    }
  );
  const rejected = assert.rejects(failed, IbkrRequestSchedulerError);
  const queued = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY", secdefInfo: true },
    async () => {
      queuedCalls += 1;
    }
  );
  await flush();
  await time.advance(100);
  await rejected;
  assert.equal(attempts, 2);
  assert.equal(queuedCalls, 0);
  await time.advance(999);
  assert.equal(queuedCalls, 0);
  await time.advance(1);
  await queued;
  assert.equal(queuedCalls, 1);
});

void test("endpoint names alone do not enable keyed pacing", async () => {
  const time = clock();
  const scheduler = new IbkrRequestScheduler({ ...time });
  const starts: number[] = [];
  const jobs = Array.from({ length: 2 }, () =>
    scheduler.schedule({ endpoint: "secdef/info", priority: "STANDARD" }, async () => {
      starts.push(time.now());
    })
  );
  await time.finish(Promise.all(jobs));
  assert.deepEqual(starts, [0, 100]);
});
