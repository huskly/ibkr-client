interface ReadJobDetails {
  kind: "read";
  accountId: string;
  prepare: () => Promise<void>;
}

interface ExclusiveJobDetails {
  kind: "exclusive";
}

type JobDetails = ReadJobDetails | ExclusiveJobDetails;
type Job = JobDetails & {
  run: () => Promise<void>;
  reject: (error: unknown) => void;
};
type ReadJob = Job & ReadJobDetails;

/** FIFO account reads with exclusive account preparation and session mutations. */
export class AccountCoordinator {
  private readonly queue: Job[] = [];
  private exclusiveActive = false;
  private activeAccount: string | undefined;
  private activeReaders = 0;

  read<T>(
    accountId: string,
    prepare: () => Promise<void>,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.enqueue({ kind: "read", accountId, prepare }, operation);
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue({ kind: "exclusive" }, operation);
  }

  private enqueue<T>(details: JobDetails, operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        ...details,
        reject,
        run: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            job.reject(error);
          }
        },
      };
      this.queue.push(job);
      this.drain();
    });
  }

  private drain(): void {
    if (this.exclusiveActive) return;

    if (this.activeReaders > 0) {
      while (this.queue[0]?.kind === "read" && this.queue[0].accountId === this.activeAccount) {
        const job = this.queue.shift() as ReadJob;
        this.activeReaders += 1;
        void this.runRead(job);
      }
      return;
    }

    const job = this.queue.shift();
    if (!job) return;
    this.exclusiveActive = true;
    if (job.kind === "exclusive") {
      void this.runExclusive(job);
    } else {
      void this.prepareRead(job);
    }
  }

  private async prepareRead(job: ReadJob): Promise<void> {
    try {
      await job.prepare();
    } catch (error) {
      job.reject(error);
      this.exclusiveActive = false;
      this.drain();
      return;
    }

    this.activeAccount = job.accountId;
    this.activeReaders = 1;
    this.exclusiveActive = false;
    void this.runRead(job);
    this.drain();
  }

  private async runRead(job: ReadJob): Promise<void> {
    await job.run();
    this.activeReaders -= 1;
    if (this.activeReaders === 0) this.activeAccount = undefined;
    this.drain();
  }

  private async runExclusive(job: Job): Promise<void> {
    await job.run();
    this.exclusiveActive = false;
    this.drain();
  }
}
