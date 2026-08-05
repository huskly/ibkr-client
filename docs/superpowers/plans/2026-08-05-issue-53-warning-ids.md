# Issue 53 Warning ID Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let callers approve any exact, well-formed IBKR warning ID while keeping malformed warning evidence fail-closed.

**Architecture:** Keep warning-shape classification inside `decodeOrderSubmission`. Remove the library-owned ID catalog and preserve the existing caller-side exact allowlist as the approval boundary. Add behavior coverage at the derivative execution API boundary and update the public README contract.

**Tech Stack:** TypeScript, Node test runner, `tsx`, Yarn Classic, Prettier, ESLint.

## Global Constraints

- Use Yarn Classic with `yarn.lock` v1 and `yarn install --frozen-lockfile`.
- Preserve strict TypeScript behavior and use `import type` for type-only imports.
- Keep broker writes single-attempt and do not add automatic warning acknowledgement.
- Keep malformed or incomplete broker warning evidence fail-closed.
- Use Simplified Technical English in README and documentation.

---

### Task 1: Add the non-catalog warning regression test

**Files:**
- Modify: `test/derivativeExecution.test.ts:174-193`

**Interfaces:**
- Consumes: `FakeIbkrClient` warning-reply fixtures and `acknowledgeOrderWarning(...)`.
- Produces: A regression assertion that a valid warning ID other than `o163` is classified as known.

- [ ] **Step 1: Change the focused fixture to include a valid non-`o163` warning ID**

Keep the existing `x999` fixture to prove an unrecognized string ID remains unknown. Add a separate `o10331` reply fixture with a valid warning message and `messageIds: ["o10331"]`, then assert that the decoded warning has `known === true`.

```ts
const responses = [
  [{ id: "unknown", message: ["Unclassified broker warning"], messageIds: ["x999"] }],
  [{ id: "other-known", message: ["Stop order disclosure"], messageIds: ["o10331"] }],
  [{ id: "known", message: ["Percentage constraint"], messageIds: ["o163"] }],
  [{ order_id: "777", order_status: "PreSubmitted" }],
];
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing behavior**

Run:

```bash
yarn tsc --noEmit -p tsconfig.test.json
node --import tsx --test test/derivativeExecution.test.ts
```

Expected: the new `o10331` assertion fails because the current decoder only marks `o163` as known.

- [ ] **Step 3: Commit the regression test**

```bash
git add test/derivativeExecution.test.ts
git commit -m "test: cover configurable warning IDs"
```

### Task 2: Remove the hardcoded catalog and document the contract

**Files:**
- Modify: `src/ibkr/ibkrClient.ts:193,2370-2383`
- Modify: `README.md:201-202`

**Interfaces:**
- Consumes: Raw IBKR warning records with `messageIds`.
- Produces: `OrderWarning.known === true` for non-empty all-string `messageIds` arrays, independent of the specific IDs.

- [ ] **Step 1: Remove the library-owned warning ID set**

Delete:

```ts
const KNOWN_ORDER_WARNING_IDS = new Set(["o163"]);
```

- [ ] **Step 2: Change only the knownness predicate**

Keep the existing filtered `messageIds` output and replace the fixed-set check with:

```ts
known:
  Array.isArray(rawMessageIds) &&
  rawMessageIds.length > 0 &&
  rawMessageIds.every((id) => typeof id === "string"),
```

This preserves `known: false` for missing, non-array, empty, or mixed-type values.

- [ ] **Step 3: Update the README warning contract**

Replace the statement that only documented IDs are known with text that says well-formed warning IDs are classified as known, while callers must still approve exact IDs and unknown or malformed warnings remain pending.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
yarn tsc --noEmit -p tsconfig.test.json
node --import tsx --test test/derivativeExecution.test.ts
```

Expected: all tests in `test/derivativeExecution.test.ts` pass, including the `o10331` and `x999` assertions.

- [ ] **Step 5: Commit the implementation and documentation**

```bash
git add src/ibkr/ibkrClient.ts test/derivativeExecution.test.ts README.md
git commit -m "fix: respect caller-configured warning IDs"
```

### Task 3: Verify the complete change

**Files:**
- Verify: `src/ibkr/ibkrClient.ts`
- Verify: `test/derivativeExecution.test.ts`
- Verify: `README.md`

**Interfaces:**
- Consumes: The complete issue-53 branch.
- Produces: Fresh evidence for tests, lint, formatting, types, build, and whitespace correctness.

- [ ] **Step 1: Run the full test suite**

```bash
yarn test
```

Expected: 164 or more tests pass with zero failures.

- [ ] **Step 2: Run repository checks**

```bash
yarn check
yarn build
git diff --check
```

Expected: lint, format check, type check, build, and diff check exit successfully.

- [ ] **Step 3: Inspect the final diff and status**

```bash
git diff master...HEAD --stat
git diff master...HEAD
git status --short --branch
```

Confirm that the diff contains only the issue-53 design/plan records, decoder change, focused regression test, and README contract update.
