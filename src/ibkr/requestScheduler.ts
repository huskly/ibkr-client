export type IbkrRequestPriority = "EXECUTION" | "STANDARD" | "DISCOVERY";

export type IbkrRequestErrorClassification =
  | { kind: "THROTTLED"; retryAfterMs?: number }
  | { kind: "TEMPORARILY_BLOCKED" }
  | { kind: "OTHER" };

export interface IbkrRequestTelemetry {
  event: "THROTTLED" | "CIRCUIT_OPEN";
  endpoint: string;
  attempt: number;
  delayMs: number;
}

export interface IbkrRequestSchedulerOptions {
  maxConcurrent?: number;
  maxDiscoveryConcurrent?: number;
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
  retryable?: boolean;
}

interface ScheduledJob {
  sequence: number;
  endpoint: string;
  priority: IbkrRequestPriority;
  retryable: boolean;
  attempts: number;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
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
  };

  private readonly maxConcurrent: number;
  private readonly maxDiscoveryConcurrent: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly circuitDurationMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly classifyError: (error: unknown) => IbkrRequestErrorClassification;
  private readonly onTelemetry: (event: IbkrRequestTelemetry) => void;
  private readonly queue: ScheduledJob[] = [];
  private sequence = 0;
  private active = 0;
  private activeDiscovery = 0;
  private backoffUntil = 0;
  private backoffPromise: Promise<void> | undefined;
  private circuitOpenUntil = 0;

  constructor(options: IbkrRequestSchedulerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 10;
    this.maxDiscoveryConcurrent = options.maxDiscoveryConcurrent ?? 1;
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
      this.maxDiscoveryConcurrent > this.maxConcurrent
    ) {
      throw new Error("Invalid IBKR request concurrency limits");
    }
  }

  schedule<T>(options: RequestOptions, task: () => Promise<T>): Promise<T> {
    const circuitError = this.currentCircuitError(options.endpoint);
    if (circuitError !== undefined) return Promise.reject(circuitError);
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        sequence: this.sequence++,
        endpoint: options.endpoint,
        priority: options.priority,
        retryable: options.retryable ?? true,
        attempts: 0,
        task,
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
      });
      this.drain();
    });
  }

  private drain(): void {
    if (this.backoffUntil > 0) {
      this.ensureBackoffWait();
      return;
    }
    while (this.active < this.maxConcurrent) {
      const index = this.nextJobIndex();
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      if (job === undefined) return;
      this.run(job);
    }
  }

  private nextJobIndex(): number {
    let selected = -1;
    for (const [index, job] of this.queue.entries()) {
      if (job.priority === "DISCOVERY" && this.activeDiscovery >= this.maxDiscoveryConcurrent) {
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
    this.active += 1;
    if (job.priority === "DISCOVERY") this.activeDiscovery += 1;
    this.metrics.maximumConcurrent = Math.max(this.metrics.maximumConcurrent, this.active);
    this.metrics.maximumDiscoveryConcurrent = Math.max(
      this.metrics.maximumDiscoveryConcurrent,
      this.activeDiscovery
    );
    void Promise.resolve()
      .then(job.task)
      .then(job.resolve)
      .catch((error: unknown) => {
        this.handleFailure(job, error);
      })
      .finally(() => {
        this.active -= 1;
        if (job.priority === "DISCOVERY") this.activeDiscovery -= 1;
        this.drain();
      });
  }

  private handleFailure(job: ScheduledJob, error: unknown): void {
    const classification = this.classifyError(error);
    if (classification.kind === "TEMPORARILY_BLOCKED") {
      this.openCircuit(job, error);
      return;
    }
    if (classification.kind !== "THROTTLED") {
      job.reject(error);
      return;
    }
    if (!job.retryable || job.attempts >= this.maxRetries) {
      job.reject(
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
    const delayMs = this.retryDelay(job.attempts, classification.retryAfterMs);
    job.attempts += 1;
    this.backoffUntil = Math.max(this.backoffUntil, this.now() + delayMs);
    this.queue.push(job);
    this.onTelemetry({
      event: "THROTTLED",
      endpoint: job.endpoint,
      attempt: job.attempts,
      delayMs,
    });
  }

  private retryDelay(attempt: number, retryAfterMs: number | undefined): number {
    const base =
      retryAfterMs ?? Math.min(this.retryBaseDelayMs * 2 ** attempt, this.retryMaxDelayMs);
    return Math.max(1, Math.ceil(base * (1 + this.jitterRatio * this.random())));
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
    job.reject(error);
    for (const queued of this.queue.splice(0)) queued.reject(error);
    this.onTelemetry({
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
