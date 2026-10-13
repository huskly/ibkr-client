import assert from "node:assert/strict";
import test from "node:test";
import { AccountCoordinator } from "../src/ibkr/accountCoordinator.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

void test("same-account reads overlap after one exclusive preparation", async () => {
  const coordinator = new AccountCoordinator();
  const preparation = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const release = deferred();
  const events: string[] = [];
  const first = coordinator.read(
    "A",
    async () => {
      events.push("prepare");
      await preparation.promise;
    },
    async () => {
      events.push("first");
      firstStarted.resolve();
      await release.promise;
      return 1;
    }
  );
  const second = coordinator.read(
    "A",
    async () => {
      events.push("unexpected prepare");
    },
    async () => {
      events.push("second");
      secondStarted.resolve();
      await release.promise;
      return 2;
    }
  );
  assert.deepEqual(events, ["prepare"]);
  preparation.resolve();
  await Promise.all([firstStarted.promise, secondStarted.promise]);
  assert.deepEqual(events, ["prepare", "first", "second"]);

  const lateStarted = deferred();
  const late = coordinator.read(
    "A",
    async () => {
      events.push("unexpected late prepare");
    },
    async () => {
      events.push("late");
      lateStarted.resolve();
      await release.promise;
      return 3;
    }
  );
  await lateStarted.promise;
  assert.deepEqual(events, ["prepare", "first", "second", "late"]);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second, late]), [1, 2, 3]);
});

void test("different-account preparation waits for all active readers and preserves FIFO", async () => {
  const coordinator = new AccountCoordinator();
  const started = deferred();
  const bothStarted = deferred();
  const firstRelease = deferred();
  const secondRelease = deferred();
  const nextRelease = deferred();
  const nextStarted = deferred();
  const events: string[] = [];
  const first = coordinator.read(
    "A",
    async () => {
      events.push("prepare A");
    },
    async () => {
      events.push("A1");
      started.resolve();
      await firstRelease.promise;
    }
  );
  await started.promise;
  const second = coordinator.read(
    "A",
    async () => {
      events.push("unexpected prepare");
    },
    async () => {
      events.push("A2");
      bothStarted.resolve();
      await secondRelease.promise;
    }
  );
  await bothStarted.promise;
  const next = coordinator.read(
    "B",
    async () => {
      events.push("prepare B");
    },
    async () => {
      events.push("B");
      nextStarted.resolve();
      await nextRelease.promise;
    }
  );
  const later = coordinator.read(
    "A",
    async () => {
      events.push("prepare A again");
    },
    async () => {
      events.push("A3");
    }
  );
  firstRelease.resolve();
  await first;
  assert.deepEqual(events, ["prepare A", "A1", "A2"]);
  secondRelease.resolve();
  await nextStarted.promise;
  assert.deepEqual(events, ["prepare A", "A1", "A2", "prepare B", "B"]);
  nextRelease.resolve();
  await Promise.all([second, next, later]);
  assert.deepEqual(events, ["prepare A", "A1", "A2", "prepare B", "B", "prepare A again", "A3"]);
});

void test("a pending exclusive job blocks later same-account reads", async () => {
  const coordinator = new AccountCoordinator();
  const readerStarted = deferred();
  const readerRelease = deferred();
  const writerStarted = deferred();
  const writerRelease = deferred();
  const events: string[] = [];
  const first = coordinator.read(
    "A",
    async () => {
      events.push("prepare A");
    },
    async () => {
      events.push("read 1");
      readerStarted.resolve();
      await readerRelease.promise;
    }
  );
  await readerStarted.promise;
  const writer = coordinator.exclusive(async () => {
    events.push("writer");
    writerStarted.resolve();
    await writerRelease.promise;
    return "written";
  });
  const later = coordinator.read(
    "A",
    async () => {
      events.push("prepare A again");
    },
    async () => {
      events.push("read 2");
    }
  );
  assert.deepEqual(events, ["prepare A", "read 1"]);
  readerRelease.resolve();
  await writerStarted.promise;
  assert.deepEqual(events, ["prepare A", "read 1", "writer"]);
  writerRelease.resolve();
  assert.equal(await writer, "written");
  await Promise.all([first, later]);
  assert.deepEqual(events, ["prepare A", "read 1", "writer", "prepare A again", "read 2"]);
});

void test("failed preparation rejects only its read and the next read prepares again", async () => {
  const coordinator = new AccountCoordinator();
  const preparation = deferred();
  const error = new Error("prepare failed");
  const events: string[] = [];
  const failed = coordinator.read(
    "A",
    async () => {
      await preparation.promise;
      throw error;
    },
    async () => {
      events.push("unexpected operation");
    }
  );
  const rejected = assert.rejects(failed, (actual: unknown) => actual === error);
  const next = coordinator.read(
    "A",
    async () => {
      events.push("prepare again");
    },
    async () => {
      events.push("next read");
      return 7;
    }
  );
  preparation.resolve();
  await rejected;
  assert.equal(await next, 7);
  assert.deepEqual(events, ["prepare again", "next read"]);
});

void test("read and exclusive failures release their slots without rejecting queued jobs", async () => {
  const coordinator = new AccountCoordinator();
  const readError = new Error("read failed");
  const writerError = new Error("writer failed");
  const release = deferred();
  const events: string[] = [];
  const failedRead = coordinator.read(
    "A",
    async () => {},
    async () => {
      events.push("failed read");
      await release.promise;
      throw readError;
    }
  );
  const readRejected = assert.rejects(failedRead, (actual: unknown) => actual === readError);
  const failedWriter = coordinator.exclusive(() => {
    events.push("failed writer");
    throw writerError;
  });
  const writerRejected = assert.rejects(failedWriter, (actual: unknown) => actual === writerError);
  const next = coordinator.read(
    "B",
    async () => {
      events.push("prepare B");
    },
    async () => {
      events.push("next read");
      return 9;
    }
  );
  release.resolve();
  await Promise.all([readRejected, writerRejected]);
  assert.equal(await next, 9);
  assert.deepEqual(events, ["failed read", "failed writer", "prepare B", "next read"]);
});
