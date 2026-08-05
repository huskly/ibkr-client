# Issue 51 Graph Client IDs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a client order ID for every derivative graph node and preserve readable synchronous rejection evidence.

**Architecture:** `IbkrClient` builds graph tickets and decodes IBKR response records. Each ticket has a deterministic `cOID`. A non-root ticket also has its deterministic `parentId`. The decoder retains raw rejection evidence in the public `BrokerErrorDetail` contract.

**Tech Stack:** TypeScript, Node.js test runner, Yarn Classic.

## Global Constraints

- Keep broker writes as single attempts.
- Treat IBKR response fields as untrusted runtime input.
- Update the README for public behavior changes.
- Use ASD-STE100 Simplified Technical English in Markdown documents.

---

### Task 1: Test and implement graph tickets

**Files:**

- Modify: `test/derivativeOrderGraph.test.ts`
- Modify: `src/ibkr/ibkrClient.ts`
- Modify: `src/ibkr/ibkrApiTypes.ts`

**Interfaces:**

- Consumes: `IbkrClient.submitDerivativeOrderGraph(request)`.
- Produces: tickets where each graph node has `cOID` and each non-root node has `parentId`.

- [ ] Write a failing three-level graph test. Assert these literal values: `pcs-42`, `pcs-42:stop`, and `pcs-42:hedge`.
- [ ] Run `yarn test test/derivativeOrderGraph.test.ts`. Confirm that it fails because a non-root ticket lacks `cOID`.
- [ ] Make `graphOrderTicket` add `cOID` for every node and `parentId` only for non-root nodes.
- [ ] Run `yarn test test/derivativeOrderGraph.test.ts`. Confirm that it passes.

### Task 2: Test and implement synchronous rejection evidence

**Files:**

- Modify: `test/derivativeOrderGraph.test.ts`
- Modify: `src/ibkr/ibkrClient.ts`
- Modify: `src/ibkr/ibkrApiTypes.ts`

**Interfaces:**

- Consumes: array response records with `order_id`, `order_status`, `text`, and `warning_message`.
- Produces: a fail-closed graph result with a `BrokerErrorDetail` and a readable recovery reason.

- [ ] Write a failing test for the issue response: `order_id: "-1"`, `order_status: "Failed"`, and the supplied parent-ID text.
- [ ] Run `yarn test test/derivativeOrderGraph.test.ts`. Confirm that it fails because the decoder loses the text.
- [ ] Decode meaningful `text` or `warning_message` from failed records into `BrokerErrorDetail`, retain raw details, and use the error message in recovery reasons.
- [ ] Run `yarn test test/derivativeOrderGraph.test.ts`. Confirm that it passes.

### Task 3: Document and verify the public behavior

**Files:**

- Modify: `README.md`

**Interfaces:**

- Consumes: the tested ticket and recovery behavior.
- Produces: public documentation for graph ticket IDs and rejection detail retention.

- [ ] Explain that every graph ticket sends `cOID`, while non-root tickets also send `parentId`.
- [ ] Explain that readable synchronous rejection fields are retained in errors and recovery reasons.
- [ ] Run `yarn run check`, `yarn test`, and `yarn build`.
- [ ] Commit the intended files with `fix: preserve graph submission evidence`, then push and open a draft pull request.
