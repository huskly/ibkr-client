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

void test("one 429 pauses queued work behind one coordinated jittered backoff", async () => {
  const backoff = deferred();
  const sleeps: number[] = [];
  const events: string[] = [];
  let firstAttempts = 0;
  const scheduler = new IbkrRequestScheduler({
    maxConcurrent: 1,
    now: () => 0,
    sleep: (ms) => {
      sleeps.push(ms);
      return backoff.promise;
    },
    random: () => 0.5,
    classifyError: (error) =>
      error instanceof Error && error.message === "429"
        ? { kind: "THROTTLED", retryAfterMs: 1_000 }
        : { kind: "OTHER" },
  });

  const first = scheduler.schedule(
    { endpoint: "secdef/strikes", priority: "DISCOVERY" },
    async () => {
      events.push(`first-${String(++firstAttempts)}`);
      if (firstAttempts === 1) throw new Error("429");
      return "first";
    }
  );
  const second = scheduler.schedule(
    { endpoint: "secdef/info", priority: "DISCOVERY" },
    async () => {
      events.push("second");
      return "second";
    }
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first-1"]);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 1_050);
  backoff.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(sleeps.length, 1);
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
