# Account Margin Values Design

## Goal

Extend `getAccountBalances()` so callers can choose among IBKR's documented
margin-related portfolio-summary values without depending on raw provider keys.

## Public contract

Keep the existing `AccountBalances` fields unchanged and add a typed `margin`
property with three snapshots:

- `total` maps aggregate summary keys with no suffix.
- `securities` maps IBKR `-s` keys.
- `commodities` maps IBKR `-c` keys.

Each snapshot exposes the same stable field names:

- `equityWithLoanValue`
- `regTEquity`
- `regTMargin`
- `initialMarginRequirement`
- `maintenanceMarginRequirement`
- `availableFunds`
- `excessLiquidity`
- `cushion`
- `sma`
- `buyingPower`
- `fullInitialMarginRequirement`
- `fullMaintenanceMarginRequirement`
- `fullAvailableFunds`
- `fullExcessLiquidity`
- `lookAheadInitialMarginRequirement`
- `lookAheadMaintenanceMarginRequirement`
- `lookAheadAvailableFunds`
- `lookAheadExcessLiquidity`
- `lookAheadNextChange`
- `leverage`

Every margin field is `number | null`. Missing, null, malformed, or
non-finite provider amounts become `null`; numeric zero remains zero. This is
important because IBKR does not return every metric for every account or
segment.

The client maps the known IBKR summary keys at the provider boundary. It does
not expose an untyped raw summary map and does not infer a Schwab-style
`marginBalance` debit/credit value from cash or equity fields.

## Data flow

`getAccountBalances()` continues to call exactly one
`portfolio/{accountId}/summary` request. It will map each known aggregate key,
then repeat the mapping with `-s` and `-c` suffixes for the securities and
commodities snapshots. Unsupported fields remain null rather than being
fabricated.

The raw `IbkrPortfolioSummary` type remains an open keyed response because the
provider can add fields independently of this package. The broker-neutral
public type remains explicit and stable.

## Testing and documentation

Add a behavior test using a fake summary response containing representative
aggregate, securities, commodities, zero, missing, and malformed values. The
test must assert the exact normalized nested result and the summary request
path. Keep the package-boundary export test passing, and update the README's
account API section with the new `margin` snapshots and nullable semantics.

No live broker request, order behavior, or unrelated balance semantics change.
