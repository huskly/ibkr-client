## Derivative Order Graphs

Think of a derivative order graph as a small order tree submitted to IBKR as one coordinated request.

### The pieces

- **Root**: the primary order, such as entering a put credit spread.
- **Descendants**: contingent orders attached to the root or to an earlier descendant.
- **Node**: one graph member. It can be a single option order or an atomic multi-leg combo.
- **`parentMemberId`**: says which order activates/owns this node.
- **`rootClientOrderId`**: your durable correlation ID for the whole graph.

Example:

```text
pcs-42: entry combo
└── pcs-42:stop   stop-loss order
    └── pcs-42:hedge  hedge/close order
```

In the request, that might look conceptually like:

```ts
{
  rootClientOrderId: "pcs-42",
  nodes: [
    { memberId: "entry", /* combo spread */ },
    { memberId: "stop", parentMemberId: "entry", /* STOP */ },
    { memberId: "hedge", parentMemberId: "stop", /* MARKET */ }
  ]
}
```

The implementation allows one root and up to eight members. Each non-root member can name any
member that comes before it.

### What IBKR receives

The root gets the caller’s client ID:

```text
root:  cOID = "pcs-42"
```

Each descendant references its exact parent:

```text
child:      parentId = "pcs-42"
grandchild: parentId = "pcs-42:stop"
```

Descendants do not send their own `cOID`. The client gives each descendant a deterministic identity,
such as `pcs-42:stop`. A later descendant can use this identity as its `parentId`. The client also
uses the identity to correlate recovery evidence.

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

`accepted` is stricter than “the broker created something.” It requires one distinct broker order ID for every requested graph member. If the submission response is partial, nested, or only some members correlate, the client returns `recovery_required` and names the members that still have no order ID. Nested child acknowledgements under `children` or `childOrders` are included in that correlation.

### Mental model

The simplest way to remember it:

> A combo describes what one order contains.
> A graph describes how multiple orders depend on one another.

The relevant public contract is in [`src/types.ts`](../src/types.ts), and the lifecycle behavior is documented in [`README.md`](../README.md#guarded-derivative-order-execution).
