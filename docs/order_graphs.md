## Derivative Order Graphs

Think of a derivative order graph as a small order tree submitted to IBKR as one coordinated request.

### The pieces

- **Root**: the primary order, such as entering a put credit spread.
- **Children**: contingent orders attached to the root, such as a stop-loss or hedge.
- **Node**: one graph member. It can be a single option order or an atomic multi-leg combo.
- **`parentMemberId`**: says which order activates/owns this node.
- **`rootClientOrderId`**: your durable correlation ID for the whole graph.

Example:

```text
pcs-42: entry combo
├── pcs-42:stop   stop-loss order
└── pcs-42:hedge  hedge/close order
```

In the request, that might look conceptually like:

```ts
{
  rootClientOrderId: "pcs-42",
  nodes: [
    { memberId: "entry", /* combo spread */ },
    { memberId: "stop", parentMemberId: "entry", /* STOP */ },
    { memberId: "hedge", parentMemberId: "entry", /* MARKET */ }
  ]
}
```

The current implementation allows one root and direct root-to-child attachments, with up to eight members.

### What IBKR receives

The root gets the caller’s client ID:

```text
root:  cOID = "pcs-42"
```

Children reference the root:

```text
child: parentId = "pcs-42"
```

Children deliberately do not send their own `cOID`. The client still gives them a derived identity internally, such as `pcs-42:stop`, so it can correlate evidence afterward.

### Graph versus combo

These are different concepts:

```text
Combo:  one broker order containing multiple legs

Graph:  multiple broker orders connected by parent/child relationships
```

A graph node can itself be a combo. For example, the root could be a put spread, while a child could be a single-leg stop order.

### Why it is not considered one atomic order

The graph is submitted in one broker request, but IBKR does not guarantee that every member will receive a clean acknowledgement. You can get:

- all members accepted;
- a warning requiring explicit continuation;
- an authoritative rejection;
- partial, contradictory, or malformed evidence.

That is why the result is not simply `success: true/false`.

`recovery_required` means: “we do not know the complete broker state.” The client retains every observed order ID and response, and callers must reconcile before attempting another write. Blind retrying could duplicate an entry or protective order.

### Mental model

The simplest way to remember it:

> A combo describes what one order contains.
> A graph describes how multiple orders depend on one another.

The relevant public contract is in [`src/types.ts`](../src/types.ts), and the lifecycle behavior is documented in [`README.md`](../README.md#guarded-derivative-order-execution).
