# Account Concurrency Implementation Plan

**Goal:** Permit safe parallel reads and enforce request pacing.
**Architecture:** One FIFO account coordinator grants shared reads or exclusive operations. One scheduler enforces global and endpoint pacing. Explicit broker evidence confirms selection.
**Tech Stack:** TypeScript, Yarn 4, node:test.
**Spec:** Approved design and amendments in the session transcript.

## Constraints

Do not touch the main checkout. Do not call IBKR, push, publish, or deploy. Keep public signatures. Bump to 4.4.0. Use a single write attempt.

### Task 1: Account coordinator
- [x] Add `src/ibkr/accountCoordinator.ts` with read and exclusive admission.
- [x] Add deferred promise tests in `test/accountCoordinator.test.ts` for shared reads, switch and writer exclusion, FIFO, and failure release.

### Task 2: Scheduler
- [x] Extend `src/ibkr/requestScheduler.ts` pacing eligibility with global 100 ms and keyed endpoint intervals.
- [x] Test exact boundaries with controlled clocks in `test/requestScheduler.test.ts`. Reject intervals above 5000 ms with `IBKR_THROTTLED` and remaining retry delay.

### Task 3: Client selection and integration
- [x] Replace the account tail with coordinator admission in `src/ibkr/ibkrClient.ts`.
- [x] Cache only validated explicit selection. Invalidate lifecycle, unsafe evidence, and ambiguous account request failures.
- [x] Guard scoped follow-up dispatch after invalidation. Preserve recovery evidence.
- [x] Route lifecycle changes exclusively. Leave raw.init handshake unwrapped.
- [x] Supply method-sensitive scheduler pacing descriptors.
- [x] Add client behavior tests and update fake clocks for existing scheduler-backed tests.

### Task 4: Release documentation and review
- [x] Update README with ownership, invalidation, pacing and bounded short waits. Update package version to 4.4.0.
- [x] Run immutable install, test, check and build.
- [x] Obtain independent full-diff review under AGENTS.md; resolve findings.
- [x] Commit separate coherent changes and report to parent.
