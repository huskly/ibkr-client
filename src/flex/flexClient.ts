import { FLEX_MAX_BYTES, flexStatementsOf, object, parseFlexDocument } from "./flexStatement.js";
import type { FlexReportRequest, FlexStatementResult } from "./types.js";

const BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

/** A redacted refusal. Only the provider's four-digit error code is retained. */
export class FlexServiceError extends Error {
  readonly code: string | null;
  constructor(code: string | null) {
    const safe = code !== null && /^\d{4}$/.test(code) ? code : null;
    super(
      safe === null
        ? "Flex service refused the request"
        : `Flex service refused the request (${safe})`
    );
    this.name = "FlexServiceError";
    this.code = safe;
  }
}

function identifier(value: string): void {
  if (!/^\d{1,64}$/.test(value)) throw new Error("Invalid Flex query or reference identifier");
}

function reportDay(value: string): void {
  if (!/^\d{8}$/.test(value)) throw new Error("Invalid Flex report date");
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const timestamp = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== iso) {
    throw new Error("Invalid Flex report date");
  }
}

function serviceResponse(document: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(document).length !== 1) throw new Error("Malformed Flex service response");
  return object(document["FlexStatementResponse"]);
}

function failure(response: Record<string, unknown>): FlexServiceError {
  const code = response["ErrorCode"];
  return new FlexServiceError(typeof code === "string" ? code : null);
}

async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Empty Flex response");
  try {
    const statedLength = Number(response.headers.get("content-length"));
    if (statedLength > FLEX_MAX_BYTES) throw new Error("Oversized Flex response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new Error("Malformed Flex response stream");
      bytes += chunk.byteLength;
      if (bytes > FLEX_MAX_BYTES) throw new Error("Oversized Flex response");
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Do not expose a transport diagnostic. */
    }
    reader.releaseLock();
  }
}

/** Read-only Flex transport. It has no brokerage session or order capability. */
export class FlexClient {
  readonly #token: string;

  constructor(token: string) {
    if (token.trim() === "") throw new Error("A Flex access token is required");
    this.#token = token;
  }

  /** Generate once. The caller owns scheduling and the documented pacing limits. */
  async requestReport(input: FlexReportRequest, signal?: AbortSignal): Promise<string> {
    identifier(input.queryId);
    reportDay(input.fromDate);
    reportDay(input.toDate);
    if (input.fromDate > input.toDate) throw new Error("Flex report dates are not ordered");
    const document = await this.request(
      "SendRequest",
      {
        q: input.queryId,
        fd: input.fromDate,
        td: input.toDate,
      },
      signal
    );
    const response = serviceResponse(document);
    if (response["Status"] === "Fail") throw failure(response);
    if (response["Status"] !== "Success" || typeof response["ReferenceCode"] !== "string") {
      throw new Error("Malformed Flex generation acknowledgement");
    }
    identifier(response["ReferenceCode"]);
    return response["ReferenceCode"];
  }

  /** Retrieve once. A pending report must be scheduled by the caller, not polled here. */
  async readStatement(referenceCode: string, signal?: AbortSignal): Promise<FlexStatementResult> {
    identifier(referenceCode);
    const document = await this.request("GetStatement", { q: referenceCode }, signal);
    if (document["FlexStatementResponse"] !== undefined) {
      const response = serviceResponse(document);
      if (response["Status"] !== "Fail") throw new Error("Malformed Flex retrieval response");
      const error = failure(response);
      if (error.code === "1019") return { status: "pending", code: "1019" };
      throw error;
    }
    const statements = flexStatementsOf(document);
    return { status: "ready", observedAtEpochMillis: Date.now(), statements };
  }

  private async request(
    operation: "SendRequest" | "GetStatement",
    params: Record<string, string>,
    caller?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const deadline = AbortSignal.timeout(30_000);
    // AbortSignal.any requires Node 20.3; keep the package's Node 20.0 contract.
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    deadline.addEventListener("abort", abort, { once: true });
    caller?.addEventListener("abort", abort, { once: true });
    if (caller?.aborted === true || deadline.aborted) abort();
    const signal = controller.signal;
    let text: string;
    try {
      signal.throwIfAborted();
      const url = new URL(`${BASE}/${operation}`);
      url.search = new URLSearchParams({ ...params, t: this.#token, v: "3" }).toString();
      const response = await fetch(url, { method: "GET", redirect: "error", signal });
      if (!response.ok) throw new Error("Flex HTTP refusal");
      text = await boundedText(response, signal);
    } catch {
      // No cause: fetch errors can contain token-bearing URLs or response data.
      if (signal.aborted) throw new DOMException("Flex request aborted", "AbortError");
      throw new Error("Flex request failed");
    } finally {
      deadline.removeEventListener("abort", abort);
      caller?.removeEventListener("abort", abort);
    }
    return parseFlexDocument(text);
  }
}
