import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  FlexClient,
  FlexServiceError,
  type FlexReportRequest,
  type FlexStatementResult,
} from "../src/index.js";

const request: FlexReportRequest = { queryId: "123", fromDate: "20260901", toDate: "20260902" };
const token = "synthetic-private-token";
const success = `<FlexStatementResponse><Status>Success</Status><ReferenceCode>456</ReferenceCode>
  <Url>https://untrusted.example/steal-token</Url></FlexStatementResponse>`;
const ready = `<FlexQueryResponse><FlexStatements count="1"><FlexStatement accountId="SYNTHETIC"
  fromDate="20260901" toDate="20260902"><CashTransactions/><Transfers/>
  </FlexStatement></FlexStatements></FlexQueryResponse>`;
function stub(t: TestContext, body: string, status = 200) {
  const calls: { url: URL; options: RequestInit | undefined }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: new URL(String(input)), options });
      return new Response(body, { status });
    }
  );
  return calls;
}
function safeError(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(
    error.message,
    /synthetic-private-token|untrusted.example|private-body|private-url/
  );
  assert.equal(error.cause, undefined);
  return true;
}

void test("generation requests the exact query and inclusive dates once", async (t) => {
  const calls = stub(t, success);
  const client = new FlexClient(token);
  assert.equal(await client.requestReport(request), "456");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url.origin, "https://ndcdyn.interactivebrokers.com");
  assert.equal(calls[0]?.url.pathname, "/AccountManagement/FlexWebService/SendRequest");
  assert.deepEqual(Object.fromEntries(calls[0]?.url.searchParams ?? []), {
    q: "123",
    fd: "20260901",
    td: "20260902",
    t: token,
    v: "3",
  });
  assert.equal(calls[0]?.options?.method, "GET");
  assert.equal(calls[0]?.options?.redirect, "error");
  assert.ok(calls[0]?.options?.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(client), /synthetic-private-token/);
});

void test("retrieval uses the fixed host and reference code, not a returned URL", async (t) => {
  const calls = stub(t, ready);
  t.mock.method(Date, "now", () => 123456);
  const result: FlexStatementResult = await new FlexClient(token).readStatement("456");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url.pathname, "/AccountManagement/FlexWebService/GetStatement");
  assert.equal(calls[0]?.url.origin, "https://ndcdyn.interactivebrokers.com");
  assert.equal(calls[0]?.url.searchParams.get("q"), "456");
  assert.equal(calls[0]?.url.searchParams.get("t"), token);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") assert.fail("Expected statement");
  assert.equal(result.observedAtEpochMillis, 123456);
  assert.equal(result.statements[0]?.statementAttributes["accountId"], "SYNTHETIC");
});

void test("1019 is explicit pending and makes no hidden polling request", async (t) => {
  const calls = stub(
    t,
    "<FlexStatementResponse><Status>Fail</Status><ErrorCode>1019</ErrorCode><ErrorMessage>private-body</ErrorMessage></FlexStatementResponse>"
  );
  assert.deepEqual(await new FlexClient(token).readStatement("456"), {
    status: "pending",
    code: "1019",
  });
  assert.equal(calls.length, 1);
});

void test("service errors retain only a validated four-digit code", async (t) => {
  for (const code of ["1003", "1018", token]) {
    stub(
      t,
      `<FlexStatementResponse><Status>Fail</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>private-body</ErrorMessage></FlexStatementResponse>`
    );
    const client = new FlexClient(token);
    for (const promise of [client.requestReport(request), client.readStatement("456")]) {
      await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof FlexServiceError);
        assert.equal(error.code, code === token ? null : code);
        return safeError(error);
      });
    }
  }
});

void test("malformed generation and retrieval envelopes never become success", async (t) => {
  for (const body of [
    "private-body",
    "<FlexStatementResponse><Status>Success</Status></FlexStatementResponse>",
    "<FlexStatementResponse><Status>Unknown</Status><ReferenceCode>456</ReferenceCode></FlexStatementResponse>",
    "<FlexStatementResponse><Status>Success</Status><ReferenceCode>private-body</ReferenceCode></FlexStatementResponse>",
    "<FlexStatementResponse><Status>Fail</Status><Status>Fail</Status><ErrorCode>1019</ErrorCode></FlexStatementResponse>",
    "<FlexStatementResponse><Status>Fail</Status></FlexStatementResponse><FlexQueryResponse/>",
  ]) {
    stub(t, body);
    await assert.rejects(new FlexClient(token).requestReport(request), safeError);
    await assert.rejects(new FlexClient(token).readStatement("456"), safeError);
  }
});

void test("invalid identifiers and report dates fail before network access", async (t) => {
  const calls = stub(t, success);
  const client = new FlexClient(token);
  for (const update of [
    { queryId: "" },
    { queryId: "a?b" },
    { fromDate: "20260230" },
    { fromDate: "2026011" },
    { fromDate: "20260903" },
    { toDate: "invalid" },
  ])
    await assert.rejects(client.requestReport({ ...request, ...update }));
  await assert.rejects(client.readStatement("../other"));
  assert.throws(() => new FlexClient("  "));
  assert.equal(calls.length, 0);
});

void test("HTTP errors and redirects are single-attempt redacted failures", async (t) => {
  for (const status of [302, 401, 429, 500]) {
    const calls = stub(t, "private-body", status);
    await assert.rejects(new FlexClient(token).requestReport(request), safeError);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.options?.redirect, "error");
  }
});

void test("transport exceptions do not leak token-bearing URLs in causes", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    throw new Error(`private-url?t=${token}`);
  });
  await assert.rejects(new FlexClient(token).requestReport(request), safeError);
  assert.equal(calls, 1);
});

void test("response bytes are bounded even without content-length", async (t) => {
  let cancelled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        })
      )
  );
  await assert.rejects(new FlexClient(token).readStatement("456"), safeError);
  assert.equal(cancelled, true);
});

void test("oversized declared response is refused before reading", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(ready, {
        headers: { "content-length": String(8 * 1024 * 1024 + 1) },
      })
  );
  await assert.rejects(new FlexClient(token).readStatement("456"), safeError);
});

void test("pre-aborted calls make no request and redact the abort reason", async (t) => {
  const calls = stub(t, success);
  await assert.rejects(new FlexClient(token).requestReport(request, AbortSignal.abort(token)), {
    name: "AbortError",
    message: "Flex request aborted",
  });
  assert.equal(calls.length, 0);
});

void test("a 30-second deadline aborts an in-flight request", async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 30000);
    return deadline.signal;
  });
  const started = Promise.withResolvers<void>();
  t.mock.method(globalThis, "fetch", async (_input: unknown, options?: RequestInit) => {
    started.resolve();
    const signal = options?.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(new Error(token));
        },
        { once: true }
      );
    });
  });
  const pending = new FlexClient(token).requestReport(request);
  await started.promise;
  deadline.abort();
  await assert.rejects(pending, { name: "AbortError", message: "Flex request aborted" });
});

void test("caller cancellation aborts body reading without exposing its reason", async (t) => {
  const caller = new AbortController();
  const reading = Promise.withResolvers<void>();
  t.mock.method(globalThis, "fetch", async (_input: unknown, options?: RequestInit) => {
    const signal = options?.signal;
    assert.ok(signal);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => {
              controller.error(new Error(token));
            },
            { once: true }
          );
        },
        pull() {
          reading.resolve();
        },
      })
    );
  });
  const pending = new FlexClient(token).readStatement("456", caller.signal);
  await reading.promise;
  caller.abort(token);
  await assert.rejects(pending, { name: "AbortError", message: "Flex request aborted" });
});

void test("invalid UTF-8 is refused instead of silently replacing financial fields", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array([0xff])));
  await assert.rejects(new FlexClient(token).readStatement("456"), safeError);
});

void test("completed reads detach caller and deadline cancellation", async (t) => {
  const caller = new AbortController();
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const calls = stub(t, ready);
  await new FlexClient(token).readStatement("456", caller.signal);
  const requestSignal = calls[0]?.options?.signal;
  assert.ok(requestSignal);
  caller.abort();
  deadline.abort();
  assert.equal(requestSignal.aborted, false);
});
