# Issue 55: Reliable Order Snapshots

## Goal

Make order-listing reads reliable when the IBKR `force=true` query returns an
empty snapshot even though live orders exist.

## Scope

Update the four `iserver/account/orders` reads in `IbkrClient` to omit
`force=true`:

- active derivative graph recovery;
- filtered terminal graph recovery;
- client-order-ID lookup in `findDerivativeOrder`;
- `listActiveDerivativeOrders`.

Keep the existing complete-snapshot and account-identity validation. Do not
change public types or package version.

## Behavior

The client sends only the exact account ID, and the terminal recovery loop also
sends its exact filter. A response must still contain `snapshot: true` and an
array of orders. A malformed or incomplete response remains a fail-closed
error or recovery result.

The regression test models the reported broker behavior: a request with
`force=true` returns an empty snapshot, while a request without it returns a
live order. The active-order API must return the live order and must not send
the unreliable query parameter.

## Documentation

Update the README active-order and recovery descriptions to state that the
client uses the normal order snapshot endpoint and fails closed for incomplete
responses.

## Validation

Run the focused derivative-order tests, then the repository checks and full
test suite:

```text
yarn test test/derivativeActiveOrders.test.ts
yarn run check
yarn test
yarn build
```
