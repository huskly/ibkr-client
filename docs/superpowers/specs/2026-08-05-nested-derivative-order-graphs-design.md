# Nested Derivative Order Graphs Design

## Goal

Allow a derivative order graph node to name any earlier node as its parent, including a child or
grandchild, while preserving ordered validation, exact broker identity matching, single-attempt
writes, and fail-closed recovery.

## Current Defect

`validateOrderGraph` first proves that a parent precedes its child, then rejects the same node unless
its parent is the root. This second restriction is based on an incorrect assumption about IBKR's
attachment behavior. The existing ticket builder already derives each attachment from the named
parent's deterministic graph client order ID, and IBKR accepts that ticket shape.

The recovery path independently assumes that every non-root broker order points to the root client
order ID. Removing only the validator restriction would therefore allow nested placement while
leaving ambiguous nested placements unrecoverable through the public safety boundary.

## Design

Keep the existing graph model and public types:

- The first node is the only root.
- Graphs contain one through eight nodes.
- Every non-root `parentMemberId` must reference a unique node that appeared earlier in the request.
- The deterministic client identity of the root is `rootClientOrderId`; the deterministic identity
  of every other node is `rootClientOrderId:memberId`.
- A ticket's `parentId` is the deterministic identity of its exact named parent.

Remove the validator's root-only parent check. Introduce one internal helper that resolves a node's
expected parent client identity, and use it consistently when building tickets and when matching
active or terminal broker evidence. Candidate scans will recognize the root identity and every
deterministic nested parent identity belonging to the request, while continuing to reject unknown,
conflicting, or unexpected attachment evidence.

No retry, warning acknowledgement, account selection, order placement, response-correlation, or
public type behavior changes are included.

## Error and Recovery Behavior

Malformed graphs still fail synchronously before authentication or network access when a parent is
missing, appears after its child, or creates an additional root. Broker responses remain untrusted.
Recovery requires exact account, order, ticket, status, and parent identity evidence; incomplete or
ambiguous evidence continues to return `recovery_required` with all observed evidence retained.

## Tests

Update the graph test fixture to represent `root -> child -> grandchild`, then verify:

- submission reaches the fake transport and emits the exact root and nested `parentId` chain;
- accepted member evidence records the grandchild role and parent broker order ID;
- a parent that has not already appeared still fails before broker access;
- active and terminal recovery correlate nested members using the exact parent identity;
- unexpected or contradictory attachments continue to fail closed.

Run the focused graph suite first, followed by lint, format check, strict typecheck, the full test
suite, build, and `git diff --check`.

## Documentation

Update README graph semantics to state that each later node may name any preceding member, remove
the obsolete one-level limitation, and retain the documented recovery and single-write guarantees.
