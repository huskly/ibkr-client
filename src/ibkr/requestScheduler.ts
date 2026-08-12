export type IbkrRequestPriority = "EXECUTION" | "STANDARD" | "DISCOVERY";

export type IbkrRequestErrorClassification =
  | { kind: "THROTTLED"; retryAfterMs?: number }
  | { kind: "SERVER_ERROR"; retryAfterMs?: number }
  | { kind: "TEMPORARILY_BLOCKED" }
  | { kind: "OTHER" };

export interface IbkrRequestTelemetry {
  event:
    | "THROTTLED"
    | "SERVER_RETRY"
    | "CIRCUIT_OPEN"
    | "SECDEF_INFO_PACING"
    | "HISTORY_PERIOD_FALLBACK"
    | "HISTORY_WINDOW_FALLBACK";
  endpoint: string;
  attempt: number;
  delayMs: number;
  /** Current minimum interval for `secdef/info` starts, when applicable. */
  effectiveMinStartIntervalMs?: number;
}

export interface IbkrRequestSchedulerOptions {
  maxConcurrent?: number;
  /** Maximum concurrent session-mutating discovery requests. Defaults to 1. */
  maxDiscoveryConcurrent?: number;
  /** Maximum concurrent read-only `secdef/info` requests. Defaults to 1. */
  maxSecdefInfoConcurrent?: number;
  /** Minimum interval between `secdef/info` request starts. Defaults to 250 ms. */
  secdefInfoMinStartIntervalMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  jitterRatio?: number;
  circuitDurationMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  classifyError?: (error: unknown) => IbkrRequestErrorClassification;
  onTelemetry?: (event: IbkrRequestTelemetry) => void;
}

interface RequestOptions {
  endpoint: string;
  priority: IbkrRequestPriority;
  /** Use the bounded read-only security-definition lane. */
  secdefInfo?: boolean;
  retryable?: boolean;
  retryServerErrors?: boolean;
  /** Cancel only the jobs that belong to this caller operation. */
  signal?: AbortSignal;
  /** Notify the owning operation before this job reports a terminal failure. */
  onTerminalFailure?: (error: unknown) => void;
}

interface ScheduledJob {
  sequence: number;
  endpoint: string;
  priority: IbkrRequestPriority;
  secdefInfo: boolean;
  retryable: boolean;
  retryServerErrors: boolean;
  attempts: number;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  onTerminalFailure?: (error: unknown) => void;
  aborted: boolean;
  finished: boolean;
}

const priorityRank: Record<IbkrRequestPriority, number> = {
  EXECUTION: 0,
  STANDARD: 1,
  DISCOVERY: 2,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class IbkrRequestSchedulerError extends Error {
  constructor(
    message: string,
    readonly code: "IBKR_THROTTLED" | "IBKR_TEMPORARILY_BLOCKED",
    readonly endpoint: string,
    readonly retryAfterMs: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "IbkrRequestSchedulerError";
  }
}

/** Priority scheduler shared by every request made through one authenticated client session. */
export class IbkrRequestScheduler {
  readonly metrics = {
    maximumConcurrent: 0,
    maximumDiscoveryConcurrent: 0,
    maximumSecdefInfoConcurrent: 0,
  };

  private readonly maxConcurrent: number;
  private readonly maxDiscoveryConcurrent: number;
  private readonly maxSecdefInfoConcurrent: number;
  private effectiveSecdefInfoMinStartIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly circuitDurationMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly classifyError: (error: unknown) => IbkrRequestErrorClassification;
  private readonly onTelemetry: (event: IbkrRequestTelemetry) => unknown;
  private readonly queue: ScheduledJob[] = [];
  private sequence = 0;
  private active = 0;
  private activeDiscovery = 0;
  private activeSecdefInfo = 0;
  private backoffUntil = 0;
  private backoffPromise: Promise<void> | undefined;
  private secdefInfoNextStartAt = 0;
  private secdefInfoPacingPromise: Promise<void> | undefined;
  private circuitOpenUntil = 0;

  constructor(options: IbkrRequestSchedulerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 10;
    this.maxDiscoveryConcurrent = options.maxDiscoveryConcurrent ?? 1;
    this.maxSecdefInfoConcurrent = options.maxSecdefInfoConcurrent ?? 1;
    this.effectiveSecdefInfoMinStartIntervalMs = options.secdefInfoMinStartIntervalMs ?? 250;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 5_000;
    this.jitterRatio = options.jitterRatio ?? 0.1;
    this.circuitDurationMs = options.circuitDurationMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.random = options.random ?? Math.random;
    this.classifyError = options.classifyError ?? (() => ({ kind: "OTHER" }));
    this.onTelemetry = options.onTelemetry ?? (() => undefined);
    if (
      !Number.isSafeInteger(this.maxConcurrent) ||
      this.maxConcurrent <= 0 ||
      !Number.isSafeInteger(this.maxDiscoveryConcurrent) ||
      this.maxDiscoveryConcurrent <= 0 ||
      this.maxDiscoveryConcurrent > this.maxConcurrent ||
      !Number.isSafeInteger(this.maxSecdefInfoConcurrent) ||
      this.maxSecdefInfoConcurrent <= 0 ||
      this.maxSecdefInfoConcurrent > this.maxConcurrent
    ) {
      throw new Error("Invalid IBKR request concurrency limits");
    }
    if (
      !Number.isSafeInteger(this.effectiveSecdefInfoMinStartIntervalMs) ||
      this.effectiveSecdefInfoMinStartIntervalMs < 0
    ) {
      throw new Error("Invalid IBKR request pacing limits");
    }
    if (
      !Number.isSafeInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      !Number.isSafeInteger(this.retryBaseDelayMs) ||
      this.retryBaseDelayMs <= 0 ||
      !Number.isSafeInteger(this.retryMaxDelayMs) ||
      this.retryMaxDelayMs < this.retryBaseDelayMs ||
      !Number.isFinite(this.jitterRatio) ||
      this.jitterRatio < 0 ||
      this.jitterRatio > 1 ||
      !Number.isSafeInteger(this.circuitDurationMs) ||
      this.circuitDurationMs <= 0
    ) {
      throw new Error("Invalid IBKR request retry limits");
    }
  }

  schedule<T>(options: RequestOptions, task: () => Promise<T>): Promise<T> {
    const circuitError = this.currentCircuitError(options.endpoint);
    if (circuitError !== undefined) return Promise.reject(circuitError);
    if (options.signal?.aborted) return Promise.reject(this.abortReason(options.signal));
    return new Promise<T>((resolve, reject) => {
      const job: ScheduledJob = {
        sequence: this.sequence++,
        endpoint: options.endpoint,
        priority: options.priority,
        secdefInfo: options.secdefInfo ?? false,
        retryable: options.retryable ?? true,
        retryServerErrors: options.retryServerErrors ?? false,
        attempts: 0,
        task,
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onTerminalFailure === undefined
          ? {}
          : { onTerminalFailure: options.onTerminalFailure }),
        aborted: false,
        finished: false,
      };
      if (job.signal !== undefined) {
        const signal = job.signal;
        job.abortListener = () => {
          job.aborted = true;
          const queuedIndex = this.queue.indexOf(job);
          if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
          this.rejectJob(job, this.abortReason(signal));
          this.drain();
        };
        signal.addEventListener("abort", job.abortListener, { once: true });
        if (signal.aborted) {
          job.abortListener();
          return;
        }
      }
      this.queue.push(job);
      this.drain();
    });
  }

  private resolveJob(job: ScheduledJob, value: unknown): void {
    if (job.finished) return;
    job.finished = true;
    this.removeAbortListener(job);
    job.resolve(value);
  }

  private rejectJob(job: ScheduledJob, error: unknown): void {
    if (job.finished) return;
    job.finished = true;
    this.removeAbortListener(job);
    if (!job.aborted) job.onTerminalFailure?.(error);
    job.reject(error);
  }

  private removeAbortListener(job: ScheduledJob): void {
    if (job.signal !== undefined && job.abortListener !== undefined) {
      job.signal.removeEventListener("abort", job.abortListener);
      delete job.abortListener;
    }
  }

  private drain(): void {
    if (this.circuitOpenUntil > this.now()) {
      for (const queued of this.queue.splice(0)) {
        this.rejectJob(queued, this.currentCircuitError(queued.endpoint));
      }
      return;
    }
    if (this.backoffUntil > 0) {
      this.ensureBackoffWait();
      return;
    }
    while (this.active < this.maxConcurrent) {
      const index = this.nextJobIndex();
      if (index < 0) {
        this.ensureSecdefInfoPacingWait();
        return;
      }
      const [job] = this.queue.splice(index, 1);
      if (job === undefined) return;
      this.run(job);
    }
    this.ensureSecdefInfoPacingWait();
  }

  private nextJobIndex(): number {
    let selected = -1;
    for (const [index, job] of this.queue.entries()) {
      if (
        job.priority === "DISCOVERY" &&
        (job.secdefInfo
          ? this.activeSecdefInfo >= this.maxSecdefInfoConcurrent ||
            this.secdefInfoNextStartAt > this.now()
          : this.activeDiscovery >= this.maxDiscoveryConcurrent)
      ) {
        continue;
      }
      if (selected < 0) {
        selected = index;
        continue;
      }
      const current = this.queue[selected];
      if (
        current !== undefined &&
        (priorityRank[job.priority] < priorityRank[current.priority] ||
          (priorityRank[job.priority] === priorityRank[current.priority] &&
            job.sequence < current.sequence))
      ) {
        selected = index;
      }
    }
    return selected;
  }

  private run(job: ScheduledJob): void {
    if (job.secdefInfo) {
      this.secdefInfoNextStartAt = this.now() + this.effectiveSecdefInfoMinStartIntervalMs;
    }
    this.active += 1;
    if (job.priority === "DISCOVERY") {
      if (job.secdefInfo) this.activeSecdefInfo += 1;
      else this.activeDiscovery += 1;
    }
    this.metrics.maximumConcurrent = Math.max(this.metrics.maximumConcurrent, this.active);
    this.metrics.maximumDiscoveryConcurrent = Math.max(
      this.metrics.maximumDiscoveryConcurrent,
      this.activeDiscovery
    );
    this.metrics.maximumSecdefInfoConcurrent = Math.max(
      this.metrics.maximumSecdefInfoConcurrent,
      this.activeSecdefInfo
    );
    void Promise.resolve()
      .then(job.task)
      .then((value) => {
        this.resolveJob(job, value);
      })
      .catch((error: unknown) => {
        this.handleFailure(job, error);
      })
      .finally(() => {
        this.active -= 1;
        if (job.priority === "DISCOVERY") {
          if (job.secdefInfo) this.activeSecdefInfo -= 1;
          else this.activeDiscovery -= 1;
        }
        this.drain();
      });
  }

  private handleFailure(job: ScheduledJob, error: unknown): void {
    if (job.aborted) return;
    const classification = this.classifyError(error);
    if (classification.kind === "TEMPORARILY_BLOCKED") {
      this.openCircuit(job, error);
      return;
    }
    if (classification.kind === "SERVER_ERROR") {
      if (!job.retryServerErrors || job.attempts >= this.maxRetries) {
        this.rejectJob(job, error);
        return;
      }
      const delayMs = this.retryDelay(job.attempts, classification.retryAfterMs);
      job.attempts += 1;
      this.emitTelemetry({
        event: "SERVER_RETRY",
        endpoint: job.endpoint,
        attempt: job.attempts,
        delayMs,
      });
      void this.sleep(delayMs).then(
        () => {
          if (job.aborted) return;
          const circuitError = this.currentCircuitError(job.endpoint);
          if (circuitError !== undefined) {
            this.rejectJob(job, circuitError);
            return;
          }
          this.queue.push(job);
          this.drain();
        },
        () => {
          this.rejectJob(job, error);
        }
      );
      return;
    }
    if (classification.kind !== "THROTTLED") {
      this.rejectJob(job, error);
      return;
    }
    const delayMs = this.retryDelay(job.attempts, classification.retryAfterMs);
    if (job.secdefInfo) {
      this.effectiveSecdefInfoMinStartIntervalMs = Math.max(
        this.effectiveSecdefInfoMinStartIntervalMs,
        delayMs
      );
      this.secdefInfoNextStartAt = Math.max(this.secdefInfoNextStartAt, this.now() + delayMs);
      this.emitTelemetry({
        event: "THROTTLED",
        endpoint: job.endpoint,
        attempt: job.attempts + 1,
        delayMs,
        effectiveMinStartIntervalMs: this.effectiveSecdefInfoMinStartIntervalMs,
      });
    }
    if (!job.retryable || job.attempts >= this.maxRetries) {
      this.rejectJob(
        job,
        new IbkrRequestSchedulerError(
          `IBKR throttled ${job.endpoint}`,
          "IBKR_THROTTLED",
          job.endpoint,
          classification.retryAfterMs ?? 0,
          { cause: error }
        )
      );
      return;
    }
    job.attempts += 1;
    if (!job.secdefInfo) {
      this.backoffUntil = Math.max(this.backoffUntil, this.now() + delayMs);
      this.emitTelemetry({
        event: "THROTTLED",
        endpoint: job.endpoint,
        attempt: job.attempts,
        delayMs,
      });
    }
    this.requeueIfActive(job);
  }

  private requeueIfActive(job: ScheduledJob): void {
    if (!job.aborted) this.queue.push(job);
  }

  private abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new Error("IBKR request was aborted", { cause: signal.reason });
  }

  private retryDelay(attempt: number, retryAfterMs?: number): number {
    const explicitRetryAfter =
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : undefined;
    const localBase = Math.min(this.retryBaseDelayMs * 2 ** attempt, this.retryMaxDelayMs);
    const base = explicitRetryAfter ?? localBase;
    const random = this.random();
    const boundedRandom = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0;
    const delayMs = Math.max(1, Math.ceil(base * (1 + this.jitterRatio * boundedRandom)));
    return explicitRetryAfter === undefined ? Math.min(this.retryMaxDelayMs, delayMs) : delayMs;
  }

  private emitTelemetry(event: IbkrRequestTelemetry): void {
    try {
      const result = this.onTelemetry(event);
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Telemetry observers cannot change request scheduling or settlement.
    }
  }

  private ensureBackoffWait(): void {
    if (this.backoffPromise !== undefined) return;
    const target = this.backoffUntil;
    const delayMs = Math.max(0, target - this.now());
    this.backoffPromise = this.sleep(delayMs).finally(() => {
      if (this.backoffUntil <= target) this.backoffUntil = 0;
      this.backoffPromise = undefined;
      this.drain();
    });
  }

  private ensureSecdefInfoPacingWait(): void {
    if (this.secdefInfoPacingPromise !== undefined) return;
    if (this.activeSecdefInfo >= this.maxSecdefInfoConcurrent) return;
    if (!this.queue.some((job) => job.secdefInfo)) return;
    const target = this.secdefInfoNextStartAt;
    const delayMs = target - this.now();
    if (delayMs <= 0) return;
    this.emitTelemetry({
      event: "SECDEF_INFO_PACING",
      endpoint: "secdef/info",
      attempt: 0,
      delayMs,
      effectiveMinStartIntervalMs: this.effectiveSecdefInfoMinStartIntervalMs,
    });
    this.secdefInfoPacingPromise = this.sleep(delayMs).then(
      () => {
        this.secdefInfoPacingPromise = undefined;
        this.drain();
      },
      (error: unknown) => {
        this.secdefInfoPacingPromise = undefined;
        const queued = this.queue.splice(0);
        for (const job of queued) {
          if (job.secdefInfo) this.rejectJob(job, error);
          else this.queue.push(job);
        }
        this.drain();
      }
    );
  }

  private openCircuit(job: ScheduledJob, cause: unknown): void {
    this.circuitOpenUntil = this.now() + this.circuitDurationMs;
    this.backoffUntil = 0;
    const error = new IbkrRequestSchedulerError(
      `IBKR temporarily blocked ${job.endpoint}`,
      "IBKR_TEMPORARILY_BLOCKED",
      job.endpoint,
      this.circuitDurationMs,
      { cause }
    );
    this.rejectJob(job, error);
    for (const queued of this.queue.splice(0)) this.rejectJob(queued, error);
    this.emitTelemetry({
      event: "CIRCUIT_OPEN",
      endpoint: job.endpoint,
      attempt: job.attempts + 1,
      delayMs: this.circuitDurationMs,
    });
  }

  private currentCircuitError(endpoint: string): IbkrRequestSchedulerError | undefined {
    const remaining = this.circuitOpenUntil - this.now();
    if (remaining <= 0) {
      this.circuitOpenUntil = 0;
      return undefined;
    }
    return new IbkrRequestSchedulerError(
      `IBKR request circuit is open for ${endpoint}`,
      "IBKR_TEMPORARILY_BLOCKED",
      endpoint,
      remaining
    );
  }
}
