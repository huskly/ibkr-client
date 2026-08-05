# Nested Derivative Order Graphs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow derivative order graph nodes to attach to any preceding member while preserving exact, fail-closed recovery.

**Architecture:** Keep the existing ordered graph request and deterministic client-order-ID scheme. Centralize exact parent client identity resolution, use it for ticket construction and broker-evidence matching, and recognize every graph-scoped client identity during active and terminal recovery scans.

**Tech Stack:** TypeScript 6, Node.js native test runner, `tsx`, Yarn Classic, ESLint, Prettier

## Global Constraints

- Use Yarn Classic and preserve `yarn.lock` v1.
- Keep all broker writes single-attempt; do not add retries or automatic warning acknowledgement.
- Treat broker responses as untrusted and retain ambiguous evidence in `recovery_required`.
- Preserve the existing public types and the one-through-eight-member graph bound.
- Every non-root parent must be a unique graph member that precedes its child.
- Update README behavior documentation with the implementation.

---

### Task 1: Accept and submit a nested graph

**Files:**
- Modify: `test/derivativeOrderGraph.test.ts:57-310`
- Modify: `src/ibkr/ibkrClient.ts:1713-1805`

**Interfaces:**
- Consumes: `DerivativeOrderGraphRequest`, `graphClientOrderId(request, node)`
- Produces: `graphParentClientOrderId(request, node): string | undefined`, used by ticket construction and Task 2 recovery matching

- [ ] **Step 1: Add a nested graph fixture and convert the rejection regression into an end-to-end submission test**

```ts
const nestedGraph = (): DerivativeOrderGraphRequest => {
  const request = graph();
  request.nodes[2]!.parentMemberId = "stop";
  return request;
};

test("submits a root, child, and grandchild with exact activation links", async () => {
  const client = new Fake((input) =>
    input.path.endsWith("/orders") && input.method === "POST"
      ? [
          { order_id: "10", order_status: "Submitted" },
          { order_id: "11", order_status: "Submitted" },
          { order_id: "12", order_status: "Submitted" },
        ]
      : session(input)
  );

  const result = await client.submitDerivativeOrderGraph(nestedGraph());
  assert.equal(result.state, "accepted");
  assert.deepEqual(
    result.members.map(({ role, parentMemberId, parentOrderId }) => [
      role,
      parentMemberId,
      parentOrderId,
    ]),
    [
      ["root", null, null],
      ["child", "entry", "10"],
      ["grandchild", "stop", "11"],
    ]
  );
  const data = client.calls.find((call) => call.method === "POST")?.data as {
    orders: Record<string, unknown>[];
  };
  assert.equal(data.orders[0]?.["cOID"], "pcs-42");
  assert.equal(data.orders[1]?.["parentId"], "pcs-42");
  assert.equal(data.orders[2]?.["parentId"], "pcs-42:stop");
});
```

- [ ] **Step 2: Run the focused test and verify the validator fails before broker access**

Run: `yarn typecheck && node --import tsx --test --test-name-pattern="root, child, and grandchild" test/derivativeOrderGraph.test.ts`

Expected: FAIL with `Derivative order graphs support only root-to-child attachments`.

- [ ] **Step 3: Remove the root-only validation branch and centralize exact parent identity**

```ts
private graphParentClientOrderId(
  request: DerivativeOrderGraphRequest,
  node: DerivativeOrderGraphNode
): string | undefined {
  if (node.parentMemberId === undefined) return undefined;
  const parent = request.nodes.find(({ memberId }) => memberId === node.parentMemberId);
  if (parent === undefined) throw new Error("Graph parent evidence was lost after validation");
  return this.graphClientOrderId(request, parent);
}
```

Delete only the `node.parentMemberId !== request.nodes[0]?.memberId` rejection. In
`graphOrderTicket`, replace the local parent lookup with `graphParentClientOrderId` and construct
`{ cOID: ... }` for the root or `{ parentId: parentClientOrderId }` for every descendant.

- [ ] **Step 4: Run the focused graph suite and verify nested submission plus malformed ordering**

Run: `yarn typecheck && node --import tsx --test --test-name-pattern="graph|grandchild|parents must precede" test/derivativeOrderGraph.test.ts`

Expected: PASS, including the existing missing/late-parent rejection before any fake transport call.

- [ ] **Step 5: Commit the nested submission change**

```bash
git add src/ibkr/ibkrClient.ts test/derivativeOrderGraph.test.ts
git commit -m "fix: allow nested derivative order graphs"
```

---

### Task 2: Recover nested graphs by exact parent identity

**Files:**
- Modify: `test/derivativeOrderGraph.test.ts:310-760`
- Modify: `src/ibkr/ibkrClient.ts:600-1065`
- Modify: `src/ibkr/ibkrClient.ts:1815-1885`
- Modify: `README.md:320-350`

**Interfaces:**
- Consumes: `graphClientOrderId(request, node)` and `graphParentClientOrderId(request, node)` from Task 1
- Produces: nested-aware `liveOrderMatchesGraphNode`, `recoveryGraphOrderMayBeAttached`, and `recoveryGraphAttachmentKey`

- [ ] **Step 1: Add active and terminal nested recovery regressions**

For the active snapshot, submit `nestedGraph()` to recovery and represent the grandchild with
`parentId: "pcs-42:stop"`; assert `accepted`, order IDs `10/11/12`, and grandchild
`parentOrderId === "11"`.

For terminal evidence, update a focused mixed active/terminal test to use `nestedGraph()` and return:

```ts
{
  account: "U1",
  orderId: "12",
  order_id: "12",
  parentId: "pcs-42:stop",
  order_status: "Filled",
  conid: 2,
  orderType: "MKT",
  side: "SELL",
  totalSize: 1,
  filled: 1,
  remaining: 0,
  tif: "DAY",
  outsideRTH: false,
}
```

Assert that exact nested evidence is accepted. Add a paired case with grandchild
`parentId: "pcs-42"` and assert `recovery_required`, proving recovery does not flatten or infer the
parent.

- [ ] **Step 2: Run the nested recovery tests and verify they fail for the current root-only matcher**

Run: `yarn typecheck && node --import tsx --test --test-name-pattern="nested|mixed active and terminal descendants" test/derivativeOrderGraph.test.ts`

Expected: FAIL because `liveOrderMatchesGraphNode` and recovery candidate scans expect
`pcs-42` for every non-root member.

- [ ] **Step 3: Match each node against its exact expected parent identity**

In `liveOrderMatchesGraphNode`, compute:

```ts
const expectedParentClientOrderId = this.graphParentClientOrderId(request, node);
```

For the root, continue requiring exact root `cOID`/`order_ref` and no parent identity. For every
descendant, require `parentIdentity.value === expectedParentClientOrderId`. Do not fall back to the
root ID or infer from array position.

- [ ] **Step 4: Make recovery scans recognize all graph-scoped identities without weakening attachment checks**

Build the allowed identity set from the request:

```ts
const graphClientOrderIds = new Set(
  request.nodes.map((node) => this.graphClientOrderId(request, node))
);
```

Use it in `recoveryGraphOrderMayBeAttached` for all existing client and parent aliases. Change
`recoveryGraphAttachmentKey` to return `"root"`, `parent:\${parentIdentity.value}`, or `null`,
so conflicting evidence attached to two different graph parents does not collapse into the same
generic `"child"` bucket. Preserve alias-consistency checks and broker-ID requirements.

- [ ] **Step 5: Run focused recovery tests**

Run: `yarn typecheck && node --import tsx --test --test-name-pattern="recovery|recovers|terminal|nested|grandchild" test/derivativeOrderGraph.test.ts`

Expected: PASS for exact nested active/terminal evidence and `recovery_required` for incorrect,
unknown, incomplete, or contradictory attachments.

- [ ] **Step 6: Update README graph and recovery semantics**

Replace the one-level limitation with: every later node names any preceding member using
`parentMemberId`; IBKR receives the deterministic exact-parent chain; recovery matches the root and
each descendant against its exact transmitted parent identity. Retain the one-through-eight bound,
warning persistence, single-attempt writes, and fail-closed recovery guarantees.

- [ ] **Step 7: Run formatting and the complete verification matrix**

Run:

```bash
yarn format
yarn lint
yarn format:check
yarn typecheck
yarn test
yarn build
git diff --check
```

Expected: every command exits 0; the full suite has zero failures; `git diff --check` emits no
output.

- [ ] **Step 8: Review the complete diff and affected contract surfaces**

Inspect `git diff master...HEAD`, then re-check analogous placement, warning continuation, active
recovery, terminal recovery, exported graph types, package-boundary tests, and README. Confirm there
are no automatic write retries, inferred account/order identities, dropped broker evidence, public
type drift, or remaining root-only parent assumptions.

- [ ] **Step 9: Commit the recovery and documentation change**

```bash
git add src/ibkr/ibkrClient.ts test/derivativeOrderGraph.test.ts README.md
git commit -m "fix: recover nested derivative order graphs"
```

- [ ] **Step 10: Push and open the pull request**

Push `fix/issue-49-nested-order-graphs`, then open a PR titled
`fix: support nested derivative order graphs` with `Fixes #49`, root cause, exact identity design,
recovery safety notes, and the complete validation matrix in the body.
