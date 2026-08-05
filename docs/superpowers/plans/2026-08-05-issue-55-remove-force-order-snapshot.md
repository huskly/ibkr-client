# Reliable Order Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop order-listing reads from sending `force=true`, because IBKR can return an empty snapshot while live orders exist.

**Architecture:** Keep the existing `flattenCompleteOrderSnapshot` validation and recovery fail-closed behavior. Change only the query parameters for the four `iserver/account/orders` read paths, then prove the request contract with tests that model the reported empty-forced/live-unforced broker behavior.

**Tech Stack:** TypeScript, Node test runner, `tsx`, Yarn Classic, Prettier, ESLint.

## Global Constraints

- Use Yarn Classic with `yarn.lock` v1 and `yarn install --frozen-lockfile`.
- Preserve strict TypeScript behavior and use `import type` for type-only imports.
- Treat IBKR responses as untrusted; keep malformed and incomplete snapshots fail-closed.
- Do not change public types or package version.
- Use Simplified Technical English in README and documentation.

---

### Task 1: Add the forced-empty snapshot regression test

**Files:**
- Modify: `test/derivativeActiveOrders.test.ts:12-45`
- Modify: `test/derivativeActiveOrders.test.ts:74-103`

**Interfaces:**
- Consumes: `FakeIbkrClient`, `listActiveDerivativeOrders`, and the order request `params`.
- Produces: A regression test that returns an empty snapshot for a forced request and a live order for an unforced request.

- [ ] **Step 1: Let the active-order fake respond to request parameters**

Change the fake constructor field from a fixed response to `unknown | ((input: RequestInput) => unknown)` and select the response in `sendRequest`:

```ts
constructor(
  private readonly orders: unknown | ((input: RequestInput) => unknown),
  private readonly selectedAccount = "U123",
  private readonly switchResponse: unknown = { set: true, acctId: "U123" }
) {
  super(config);
}

// inside sendRequest, for iserver/account/orders:
const response =
  typeof this.orders === "function" ? this.orders(input) : this.orders;
return Promise.resolve(response as T);
```

- [ ] **Step 2: Write the failing regression test**

Add this test after the first active-order test:

```ts
void test("does not miss a live order hidden by a forced empty snapshot", async () => {
  const liveOrder = {
    account: "U123",
    orderId: 99,
    conid: 101,
    side: "BUY",
    totalSize: 1,
    filled: 0,
    remaining: 1,
    status: "Submitted",
  };
  const client = new FakeIbkrClient((input) =>
    input.params?.force === true
      ? { snapshot: true, orders: [] }
      : { snapshot: true, orders: [liveOrder] }
  );

  const orders = await client.listActiveDerivativeOrders("U123");

  assert.deepEqual(orders.map(({ orderId }) => orderId), ["99"]);
  assert.deepEqual(client.calls.at(-1)?.params, { accountId: "U123" });
});
```

- [ ] **Step 3: Update the existing request-shape assertion**

Change the first test's final assertion from `{ force: true, accountId: "U123" }` to `{ accountId: "U123" }`.

- [ ] **Step 4: Run the focused test and verify it fails for the missing behavior**

Run:

```bash
yarn tsc --noEmit -p tsconfig.test.json
node --import tsx --test test/derivativeActiveOrders.test.ts
```

Expected: the new test fails because the current implementation sends `force: true` and receives the empty order array.

- [ ] **Step 5: Commit the regression test**

```bash
git add test/derivativeActiveOrders.test.ts
git commit -m "test: cover forced empty order snapshots"
```

### Task 2: Remove the unreliable query parameter from every listing path

**Files:**
- Modify: `src/ibkr/ibkrClient.ts:606-609`
- Modify: `src/ibkr/ibkrClient.ts:817-820`
- Modify: `src/ibkr/ibkrClient.ts:1272-1276`
- Modify: `src/ibkr/ibkrClient.ts:1291-1295`

**Interfaces:**
- Consumes: Exact account and terminal filter values already used by each method.
- Produces: `iserver/account/orders` params `{ accountId }` for unfiltered reads and `{ accountId, filters }` for filtered reads.

- [ ] **Step 1: Remove `force` from active graph recovery**

Use:

```ts
params: { accountId: input.accountId },
```

- [ ] **Step 2: Remove `force` from filtered terminal recovery**

Use:

```ts
params: { accountId, filters: filter },
```

- [ ] **Step 3: Remove `force` from client-order-ID lookup**

Use:

```ts
params: { accountId: input.accountId },
```

- [ ] **Step 4: Remove `force` from active derivative order listing**

Use:

```ts
params: { accountId },
```

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
node --import tsx --test test/derivativeActiveOrders.test.ts
```

Expected: all active-order tests pass, including the forced-empty regression.

- [ ] **Step 6: Commit the source change**

```bash
git add src/ibkr/ibkrClient.ts test/derivativeActiveOrders.test.ts
git commit -m "fix: remove force flag from order snapshots"
```

### Task 3: Verify the other order-listing callers

**Files:**
- Modify: `test/derivativeExecution.test.ts:234-287`
- Modify: `test/derivativeOrderGraph.test.ts:408-437`

**Interfaces:**
- Consumes: Existing `findDerivativeOrder` and `recoverDerivativeOrderGraph` fixtures.
- Produces: Assertions that client-ID lookup and graph recovery never send `force`, including all filtered terminal reads.

- [ ] **Step 1: Assert the client-ID lookup request parameters**

After the existing lifecycle assertions, add:

```ts
assert.deepEqual(
  client.calls
    .filter(({ path }) => path === "iserver/account/orders")
    .map(({ params }) => params),
  [{ accountId: "U123" }]
);
```

- [ ] **Step 2: Assert graph recovery request parameters**

The existing test invokes recovery twice. Assert that each invocation sends the active and three filtered terminal snapshots:

```ts
assert.deepEqual(
  client.calls
    .filter(({ path }) => path === "iserver/account/orders")
    .map(({ params }) => params),
  [
    { accountId: "U1" },
    { accountId: "U1", filters: "filled" },
    { accountId: "U1", filters: "cancelled" },
    { accountId: "U1", filters: "inactive" },
    { accountId: "U1" },
    { accountId: "U1", filters: "filled" },
    { accountId: "U1", filters: "cancelled" },
    { accountId: "U1", filters: "inactive" },
  ]
);
```

- [ ] **Step 3: Run the focused caller tests**

Run:

```bash
node --import tsx --test test/derivativeExecution.test.ts test/derivativeOrderGraph.test.ts
```

Expected: all tests pass and every order-listing request omits `force`.

- [ ] **Step 4: Commit the caller coverage**

```bash
git add test/derivativeExecution.test.ts test/derivativeOrderGraph.test.ts
git commit -m "test: verify unforced order listing paths"
```

### Task 4: Document and validate the behavior

**Files:**
- Modify: `README.md:216-227`
- Verify: `docs/superpowers/specs/2026-08-05-issue-55-remove-force-order-snapshot-design.md`

**Interfaces:**
- Consumes: The final read behavior and existing snapshot validation contract.
- Produces: Public documentation that explains normal snapshots and fail-closed incomplete responses.

- [ ] **Step 1: Update the active-order README contract**

Add that `listActiveDerivativeOrders(accountId)` reads the normal order snapshot endpoint without the unreliable cache-clearing flag, and that an incomplete snapshot rejects the entire read.

- [ ] **Step 2: Update the recovery README contract**

State that graph recovery uses normal active and filtered terminal snapshots and fails closed when any required snapshot is incomplete.

- [ ] **Step 3: Run formatting and repository checks**

Run:

```bash
yarn format:check
yarn run check
yarn test
yarn build
```

Expected: each command exits with status 0.

- [ ] **Step 4: Review the complete diff and commit the documentation**

```bash
git diff master...HEAD --stat
git diff master...HEAD -- src/ibkr/ibkrClient.ts test README.md docs/superpowers
git add README.md docs/superpowers/plans/2026-08-05-issue-55-remove-force-order-snapshot.md
git commit -m "docs: document reliable order snapshots"
```
