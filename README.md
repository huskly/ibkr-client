# IBKR Client (`@huskly/ibkr-client`)

A reusable TypeScript client for the **Interactive Brokers Web API**,
authenticating over **OAuth 1.0a** without the Client Portal Gateway. This
package contains no command-line interface; terminal commands and presentation
belong exclusively in [huskly/cli](https://github.com/huskly/cli).

The OAuth 1.0a live-session-token handshake is performed by the
[`ibkr-client`](https://github.com/art1c0/ibkr-client) package. See the
[`ibind` OAuth 1.0a wiki](https://github.com/Voyz/ibind/wiki/OAuth-1.0a) for how
the keys below are generated and registered in the IBKR self-service portal.

## Layout

The repository contains only the reusable client library:

| Path                             | Purpose                                                                     |
| -------------------------------- | --------------------------------------------------------------------------- |
| `src/types.ts`                   | Broker-neutral `BrokerClient` interface and normalized domain types         |
| `src/ibkr/ibkrClient.ts`         | `IbkrClient` — typed wrapper over `ibkr-client` implementing `BrokerClient` |
| `src/ibkr/oauthConfig.ts`        | Builds the OAuth config from `.pem` files + env vars                        |
| `src/ibkr/dhPrime.ts`            | Extracts the DH prime (hex) from `dhparam.pem`                              |
| `src/ibkr/optionContract.ts`     | Canonical OSI parsing and formatting for IBKR option contracts              |
| `src/ibkr/derivativeContract.ts` | Normalizes OPT/FOP identity and market-data availability                    |

The `*.pem` files (`private_signature.pem`, `private_encryption.pem`,
`dhparam.pem`, plus the public keys) are the cryptographic material from the
wiki setup step and are git-ignored.

## Setup

```bash
yarn install --frozen-lockfile
```

Provide the account-specific secrets, either by copying the template:

```bash
cp .env.example .env
# then edit .env
```

or by exporting them in your shell:

```bash
export IBIND_OAUTH1A_CONSUMER_KEY=...        # 9-char consumer key from IBKR
export IBIND_OAUTH1A_ACCESS_TOKEN=...        # access token from the portal
export IBIND_OAUTH1A_ACCESS_TOKEN_SECRET=... # access token secret from the portal
```

Optional environment variables:

- `IBIND_OAUTH1A_REALM` — OAuth realm (defaults to `limited_poa` for the
  individual self-service flow).
- `IBKR_KEYS_DIR` — directory holding the `.pem` files (defaults to the current
  working directory).
- `IBKR_ACCOUNT_ID` — target a specific account (otherwise the first is used).
- `IBKR_TRANSACTION_CURRENCY` — transaction-query currency (defaults to `USD`).

## Library API

`IbkrClient` owns IBKR authentication, requests, raw response types, and
normalization. Consumers such as huskly-cli provide presentation, command
routing, and caching. Public request types are the caller contract: this package assumes consumers
use TypeScript and pass values accepted by those types. Provider responses remain untrusted and are
validated at runtime. Its broker-neutral account API includes:

- `getAccountBalances()` and `getPositions()` for account state. Each position carries its current
  session's broker contract ID for exact follow-up reads. Account balances include typed
  `margin.total`, `margin.securities`, and `margin.commodities` snapshots with IBKR's available
  funds, buying power, excess liquidity, cushion, SMA, equity-with-loan, Reg-T, initial- and
  maintenance-margin, full, look-ahead, and leverage values. The client removes comma separators
  from numeric provider strings, such as day P/L field `78` and account summary amounts. Margin
  values are `null` when IBKR omits or returns an invalid value; numeric zero remains `0`.
- `getQuotes()` and `searchInstruments()` for equity/ETF discovery and quotes. Quote requests accept
  a symbol and an optional broker ID. A broker ID reads that exact contract without symbol
  discovery. A request without one can also resolve a complete OSI option symbol without loading
  its option chain. By default, `getQuotes()` adds five days of price history to each snapshot. Pass
  `{ includeHistory: false }` as the second argument to get snapshot data without a request to
  `iserver/marketdata/history`. Snapshot warm-up, market-data availability, and timestamps do not
  change. Without history, `reference.description`, `quote.lastPrice`, `quote.highPrice`,
  `quote.lowPrice`, `quote.netChange`, `quote.netPercentChange`, and `quote.totalVolume` are present
  only if contract or snapshot data supplies them. `quote.closePrice` and `quote.openPrice` are not
  present. A symbol request resolves the contract from `iserver/secdef/search`, and it selects the
  one contract of that exact symbol which lists options on SMART. This is the same rule the
  price-history path uses, so an index root such as `SPX` reads the CBOE index. `trsrv/stocks` is
  equity-only and answers index roots with unrelated foreign stocks that share the ticker, so stock
  search serves only symbols with no SMART options, and only if it names exactly one contract.
  Non-stock roots without SMART options, such as futures roots, use the same
  `iserver/secdef/search` result. A symbol that stays ambiguous gets no contract, and `getQuotes()`
  omits it instead of reporting a wrong price under the requested symbol.
  That search validates the HTTP payload at one shared boundary. A success array continues. An IBKR
  error object throws `IbkrBrokerResponseError` and keeps the broker detail. Any other shape fails
  closed as a malformed response. An error object is never an empty successful search.
- `fetchTransactionHistory()` for normalized portfolio transactions.
- `fetchOrders()` for normalized live orders, including aggregate `WORKING`
  matching across IBKR's active order states.

### Strategy market data

The reusable `IbkrClient` also exposes typed, read-only strategy data:

- `getPriceHistory(...)` returns normalized OHLCV bars and the validated IBKR contract context.
  A symbol-only request selects the only exact `STK` or `IND` contract that also has `SMART` option
  routing. It rejects the result when this rule does not identify one contract. Use `contract.conid`
  for an exceptional explicit selection.
  You can also set `contract.assetClass` and `contract.exchange` as validation constraints. The
  history request includes the validated exchange. IBKR uses the primary exchange when the exchange
  parameter is absent.

```ts
const history = await client.getPriceHistory({
  symbol: "SPX",
  days: 220,
});
console.log(history.contract, history.request, history.bars);
```

Set `onPriceHistoryTelemetry` in `IbkrClient` options to receive safe request metadata. The event
contains the requested symbol, resolved conid, security type, exchange, period, and bar size. The
client does not put account data, credentials, or URLs in this event.

Give a positive `days` value, or give `startDate` and `endDate` as epoch milliseconds. The client
uses inclusive UTC calendar dates for daily-bar filtering. The shared request scheduler makes the
only transport retries: it retries a price-history 5xx response with bounded backoff. The client
does not add a second retry loop. If the structured HTTP 500 `Chart data unavailable` error stays
after those retries, the client requests one covering `1y` period or at most 12 overlapping 90-day
windows. Each window must have data in the seven calendar days at both edges. Adjacent windows must
have overlapping data ranges. This rule does not assume a Monday-to-Friday trading week or require
data on an exchange holiday. Bars are in time order and duplicate timestamps are removed.
Conflicting duplicates fail closed.

The client throws `IbkrInsufficientHistoryError` if the response does not cover the interval. The
error contains the requested interval and all available boundaries from completed windows.
`onRequestTelemetry` reports the `SERVER_RETRY`, `HISTORY_PERIOD_FALLBACK`, and
`HISTORY_WINDOW_FALLBACK` event, attempt, and delay. These events do not contain the contract or
interval. Authentication, entitlement, invalid contract, and ambiguous contract errors do not start
recovery.

- `getOptionExpiries(...)` discovers weekly and monthly maturities across month buckets.
- `getOptionChain(symbol, expiry, right?)` is the strict strategy-ready path. It returns only
  exact-expiry contracts that have bid, ask, and delta values. It fails if no contract has all three
  values. Set `right` to `C` or `P` to skip definition and quote requests for the unused side.
- `getOptionChainSnapshot(symbol, expiry, right)` returns every qualified contract for one exact
  expiry and option side. It preserves canonical OSI symbols and conids. Missing bid, ask, mid,
  delta, volume, open interest, availability, and timestamp values are `null`. The result includes
  qualified, returned, malformed-definition, and missing-field counts. These diagnostics contain no
  account IDs or credentials. If a warmed snapshot stays sparse, the method returns the fields that
  IBKR supplied and keeps the other fields as `null`.
- `getOptionQuote(...)` resolves and prices one exact contract with the strict market-data shape.
  It serializes the session search with one exact security-definition request. It caches an
  identical exact request and does not load the complete option chain. When an exact ticker has listings in more than one market, option
  discovery selects the one listing with `SMART` option routing. It rejects the result if `SMART`
  does not identify one listing.
- `getOptionContract(conid)` maps a broker conid back to durable OSI identity.

The option discovery methods submit at most eight `secdef/info` definitions at one time. The next
chunk starts only after the current chunk succeeds. Multi-month expiry discovery completes one month
before it starts the next month. A terminal failure cancels queued definitions that belong to that
operation. It does not cancel definitions that belong to another operation. HTTP requests that
started before cancellation can settle normally.

Pass an `OptionDiscoveryOptions` value as the last argument to stop one operation with a standard
`AbortSignal`:

```ts
const controller = new AbortController();
const expiries = client.getOptionExpiries("SPX", "C", from, to, {
  signal: controller.signal,
});
controller.abort();
await expiries;
```

`getOptionChain` and `getOptionChainSnapshot` accept the same final options argument. Their signal
applies to definition discovery and market-data snapshots. An aborted operation rejects with the
signal reason when it is an `Error`. A non-error custom reason is retained as the `cause` of an
`Error`. An `AbortController` without a custom reason uses the standard `AbortError`.

### Broker-neutral derivative discovery

`IbkrClient` implements the capability-specific `DerivativeDiscoveryClient` without adding
derivative operations to the smaller account-oriented `BrokerClient`:

- `getDerivativeExpiries(...)` lists exact series identity over a calendar range.
- `getDerivativeContracts(...)` discovers all matching contracts for one expiration.
- `resolveDerivativeContract(...)` returns exactly one contract and rejects ambiguous trading
  classes.
- `getDerivativeChain(...)` prices one exact expiration and fails when no usable bid/ask exists.
- `getDerivativeReferenceQuote(...)` follows IBKR's `undConid` to quote the actual linked
  underlying contract, such as the September NQ future behind an August QN3 option.

Both `OPT` and `FOP` use the stateful `secdef/search` -> `secdef/strikes` -> `secdef/info`
sequence. FOP discovery derives a unique exchange such as CME from the search result when the
caller does not provide one. Index-option callers can select a venue explicitly, such as SMART.
Every `secdef/search` consumer shares the same response validation: success arrays, typed broker
errors for documented error objects, and fail-closed malformed-response errors.

```ts
const nq = await client.resolveDerivativeContract({
  assetClass: "FOP",
  underlying: "NQ",
  expiration: "2026-08-21",
  strike: 26600,
  right: "P",
  tradingClass: "QN3",
});
// nq.multiplier === 20; nq.exchange === "CME"

const ndxp = await client.resolveDerivativeContract({
  assetClass: "OPT",
  underlying: "NDX",
  expiration: "2026-08-20",
  strike: 26600,
  right: "P",
  tradingClass: "NDXP",
  exchange: "SMART",
});
```

Semantic identity consists of asset class, underlying, expiration, strike, right, trading class,
exchange, and multiplier. `conid` is returned only because this package is the IBKR boundary; it
is broker-local, can change, and must not be persisted as durable strategy identity. Optional
settlement and exercise-style fields are preserved when IBKR supplies them.

Derivative quotes use nullable values for missing prices and Greeks and normalize field `6509`
to `live`, `delayed`, `frozen`, `frozen-delayed`, or `unavailable`. A missing subscription is
never reported as live data. All discovery APIs are read-only and do not call preview, order,
warning-reply, or cancellation endpoints.

Full-chain contract discovery always calls `secdef/search` before `secdef/strikes`, because IBKR
keeps that priming state in the authenticated session. The client serializes the complete priming
transaction with all other security-definition searches. An exact OSI lookup runs its search and
one `secdef/info` request in the same serialized transaction. The client caches an identical exact
lookup, but a different lookup primes the session again. Empty post-prime strikes and incomplete
bid/ask/delta snapshots throw instead of looking like a valid chain with no candidates.
Request shaping is resilient by design: option discovery normalizes the requested symbol,
applies bounded batching for secondary-definition and market-data calls, and retries read-only
requests on transient `429` responses with capped exponential backoff (including `Retry-After`
headers when available). If every returned contract is unusable (missing bid/ask/delta), the
client now fails noisily so callers can handle that condition explicitly.
Option volume and open interest are required nullable fields: numeric zero remains zero, while
missing, unsupported, or non-finite provider values are returned as `null`.
Conids are broker-boundary identifiers; consumers should persist the returned OSI `symbol`.

### Explicit derivative What-If previews

`IbkrClient` also implements `DerivativePreviewClient`, a deliberately narrow capability with
no placement, reply-confirmation, modification, or cancellation method. Callers must provide an
exact account ID; the client never selects the first account for preview work.

- `getTradingDiagnostics(accountId)` reports authentication, selected account, paper/live state,
  market-data access, and advisory asset permissions. It does not switch accounts or preview an
  order.
- `previewDerivativeCombo(...)` accepts two exact contracts with signed ratios and a positive
  user-facing credit/debit. It requests the required market-data snapshot, constructs one atomic
  `conidex`, and calls only `/orders/whatif`.

For a BUY-oriented combo, IBKR encodes a net credit as a negative limit price. That provider
detail remains inside this package: callers send `{ priceEffect: "CREDIT", limit: 39 }`. The
normalized result includes paper/live environment, commission, initial and maintenance margin,
warnings, rejection reasons, and `submitted: false`. An incomplete nominal success fails closed.
Permission metadata is diagnostic only; the What-If response remains authoritative.

### Guarded derivative order execution

`IbkrClient` implements a separate `DerivativeExecutionClient` capability for callers that have
already enforced their own reviewed-preview workflow. It does not persist previews or decide
whether live execution is allowed.

Submission rejection is authoritative only when IBKR returns its documented top-level error object
with a meaningful message, code, or failure status. Array-contained or non-diagnostic error fields
return `recovery_required`, because they do not prove that every submitted ticket failed.

- `submitDerivativeSingleOrder(...)` places one single-leg LIMIT or STOP option order with exact
  contract, side, quantity, TIF, and session. Standalone orders require a unique client order ID;
  sequentially attached child orders instead require the parent's exact ID and omit their own
  `cOID`, as required by IBKR. LIMIT and STOP requests are discriminated: LIMIT orders require only
  a positive `limit`, while STOP orders require only a positive `stopPrice`. Equity-option (`OPT`)
  orders omit CME-only fields; futures-option (`FOP`) orders require the caller's exact `extOperator`
  and `manualIndicator`. Mixed, multiple, unknown, or malformed response evidence returns
  `recovery_required`; pending-cancel acknowledgements also require recovery. Callers must reconcile
  the retained broker order IDs before another write.
- `submitDerivativeCombo(...)` places one atomic combo with the exact legs, signed ratios,
  quantity, price effect, limit, TIF, and session supplied by the caller. The request requires a
  unique client order ID. Futures-option (`FOP`) writes also require the caller's exact CME
  `extOperator` and manual/automated-origin `manualIndicator`; equity-option (`OPT`) writes omit
  both CME-only fields. As with single orders, ambiguous response evidence returns
  `recovery_required` and must block blind resubmission.
- `submitDerivativeContingentOrders(...)` places a general parent/child LIMIT-or-STOP pair in one
  bracket request. The parent carries the caller's unique client order ID; the client derives the
  child's `parentId` from it and deliberately omits a child `cOID`. Parent and child must target the
  same account, but may reference the same or different contracts. IBKR does not promise an
  all-or-none response: `accepted` therefore requires exactly two non-failure acknowledgements,
  while mixed, incomplete, pending-cancel, canceled, rejected, unknown, or malformed evidence is
  returned as `recovery_required` with every observed broker order ID retained.
- `acknowledgeOrderWarning(...)` replies once to an exact broker warning ID. Warnings with a
  non-empty array of string message IDs are marked `known`; callers must still approve exact IDs,
  and malformed or missing IDs remain unknown.
- A warning from `submitDerivativeContingentOrders(...)` includes a typed `continuation` containing
  the exact reply ID and parent client ID. Pass that object unchanged to
  `acknowledgeContingentOrderWarning(...)`; its result retains both broker acknowledgements or
  returns all partial evidence as `recovery_required`. Do not route contingent warnings through the
  single-order acknowledgement method.
- `getDerivativeOrderStatus(...)` uses IBKR's exact order-ID status endpoint so fast terminal
  orders remain visible after live-list eviction. It normalizes pending, working, partial-fill,
  fill, canceled, and rejected lifecycle states with leg ratios and order economics, and fails
  closed on identity mismatch, unknown status, or missing aggregate quantities.
- `findDerivativeOrder(...)` accepts exactly one broker order ID or caller-supplied customer order
  ID (`cOID`/`order_ref`). Broker IDs go directly to the exact endpoint; a customer ID is resolved
  through the live list and then read by exact broker ID.
- `listActiveDerivativeOrders(accountId)` is the pre-placement risk view for one exact account. It
  reads the normal IBKR order snapshot endpoint without the unreliable cache-clearing flag. It
  preserves every signed USD `conidex` member, including exchange-qualified spreads, and applies
  the outer order side to each ratio (or preserves a single conid/side). Caller and broker IDs,
  including echoed client `parentId` ownership, remain distinct alongside graph role, quantities,
  lifecycle, pricing, TIF, session, timestamps, and unambiguous single-leg OSI option identity.
  Combo identities are not inferred from description order without a conid correlation. Malformed legs,
  aggregate-only rows, unknown statuses or directions, missing or
  ambiguous parents, and duplicate graph members are returned with explicit `uncertainty` rather
  than silently discarded. An account mismatch or an incomplete IBKR snapshot rejects the entire
  read, preventing a partial collection from being used as the pre-placement risk view. This active
  collection is not terminal history: after an order leaves it, use
  `getDerivativeOrderStatus(...)` with its broker ID as the authoritative exact lookup.
- `getDerivativeExecutions(...)` reads up to seven calendar days from IBKR's trade history and
  returns individual leg fills with execution ID, conid, side, quantity, price, commission,
  commission currency, net amount, venue, and execution time. Customer order IDs allow fills to be
  reconciled back to the atomic combo. Missing provider values remain `null` rather than estimated.
- `reconcileDerivativeComboExecution(...)` polls delayed trade publication to a bounded deadline,
  correlates by the unique client order reference, rejects duplicate or mismatched evidence, and
  validates each expected leg's side and ratio-derived quantity. Its sanitized result separates
  gross option points, multiplier-adjusted gross dollars, commission, and net dollars without
  exposing account or execution IDs.
- `cancelDerivativeOrder(...)` sends one exact cancellation request and returns only a typed
  `requested` acknowledgement. Its required `assetClass` lets the client apply the same
  product-aware CME metadata rule without guessing from an order ID. Callers remain responsible
  for reading until a terminal state and verifying that cancellation reached `CANCELED`.

Placement, warning replies, and cancellation deliberately use single-attempt HTTP writes so a
transport retry cannot duplicate a broker action. A BUY-oriented net credit remains negative at
the IBKR boundary, matching the What-If ticket exactly. Every write requires the exact account ID;
the library never falls back to the first account. Broker-declared order rejections retain their
structured response in `BrokerErrorDetail.details`; transport exceptions are rethrown intact.

### Request pacing and temporary blocks

Every authenticated request runs through one priority scheduler per `IbkrClient`. The default
limits allow at most ten requests globally. Stateful security-definition discovery stays at one
request at a time. Read-only `iserver/secdef/info` expansion defaults to one concurrent request and
at least 250 ms between request starts. Configure these limits with `maxSecdefInfoConcurrent` and
`secdefInfoMinStartIntervalMs`; concurrency cannot exceed the global limit. Order preview, status,
warning, cancellation, and immediate-trade requests take priority over queued discovery, including
while definition work waits for its next allowed start. Multi-month derivative discovery also primes
each month serially. A session-level
transaction guard keeps each stateful security-definition search with its dependent strike request.
For option-chain discovery, independent definition reads run outside this guard after search and
strikes finish. An exact expiry/strike/right request expands only the requested contracts.

A `secdef/info` 429 extends one endpoint-wide wait and raises the effective minimum start interval.
It honors `Retry-After` and does not block execution requests. A 429 from another endpoint pauses the
shared queue behind one `Retry-After`-aware exponential backoff with jitter. Individual queued reads
do not start independent retry loops, and the retry count does not increase. Exhausted throttling
throws `IbkrRequestSchedulerError` with code `IBKR_THROTTLED`. A broker temporary-block response
opens a bounded circuit, rejects queued work, and throws code `IBKR_TEMPORARILY_BLOCKED` without a
retry.

A price-history read retries a 5xx response with bounded exponential backoff and jitter. No other
request retries a 5xx response. An explicit `Retry-After` value replaces the local backoff delay
and is not reduced to the local exponential-backoff limit. Safe reads can retry a 429 even when the
IBKR endpoint uses POST. Order placement, warning replies, cancellation, account selection, and
all other writes have one HTTP attempt, including for 429 and 5xx responses.

Public HTTP failures, including initialization failures, use `IbkrHttpError`. Its `status`,
`statusCode`, and `response` fields keep the final numeric status, a bounded response body, and the
safe `Retry-After` value when it is available. Callers do not have to parse the error message.

`IbkrClient` accepts optional scheduler limits and an `onRequestTelemetry` callback. Scheduler
options also accept `now`, `sleep`, and `random` functions for controlled runtimes and tests.
Request telemetry contains only a sanitized endpoint category, event, attempt, applied delay, and
the effective `secdef/info` minimum start interval when it applies. It contains no parameters,
payloads, or account data. `onOptionDiscoveryTelemetry` reports search, strikes, definitions, and
snapshot phases. It includes the symbol, month, optional right, duration, definition request count,
and snapshot batch count. It
does not contain account IDs, order IDs, credentials, request payloads, or full URLs. A telemetry
observer failure does not change request scheduling or request settlement.

### Authorized read-only smoke test

Run this only after the account owner authorizes a read-only brokerage request and the OAuth
environment from Setup is present. Supply an explicit calendar window; the client does not
source strategy time from IBKR. This calls account, security-definition, history, and
market-data endpoints only—never preview, placement, reply-confirmation, or cancellation.

```bash
IBKR_SMOKE_SYMBOL=MSTR \
IBKR_SMOKE_FROM=2026-08-01 \
IBKR_SMOKE_TO=2026-08-31 \
node --input-type=module <<'NODE'
import { IbkrClient, buildOauthConfig } from "./dist/index.js";

const client = new IbkrClient(buildOauthConfig());
await client.init();
const symbol = process.env.IBKR_SMOKE_SYMBOL;
const from = process.env.IBKR_SMOKE_FROM;
const to = process.env.IBKR_SMOKE_TO;
if (!symbol || !from || !to) throw new Error("Smoke symbol/from/to are required");

const [balances, history, expiries] = await Promise.all([
  client.getAccountBalances(),
  client.getPriceHistory({ symbol, days: 5 }),
  client.getOptionExpiries(symbol, "C", from, to),
]);
const expiry = expiries[0];
if (!expiry) throw new Error(`No listed expiries for ${symbol} in ${from}..${to}`);
const chain = await client.getOptionChain(symbol, expiry, "C");
console.log({ equityRead: Number.isFinite(balances.netLiquidation), historyBars: history.bars.length,
  expiry, contracts: chain.length, first: chain[0]?.symbol });
NODE
```

### Live SPX history drill

Run this read-only drill in a session that has CBOE index market-data permission. The drill is not
part of the automated test suite.

```bash
node --input-type=module <<'NODE'
import { IbkrClient, buildOauthConfig } from "./dist/index.js";

const client = new IbkrClient(buildOauthConfig(), {
  onPriceHistoryTelemetry: (event) => console.log(event),
});
await client.init();
const result = await client.getPriceHistory({
  symbol: "SPX",
  contract: { conid: 416904, assetClass: "IND", exchange: "CBOE" },
  days: 220,
});
if (result.bars.length === 0) throw new Error("IBKR returned no SPX history bars");
console.log({ contract: result.contract, bars: result.bars.length });
NODE
```

## Development

```bash
yarn lint       # eslint
yarn format     # prettier --write
yarn typecheck  # tsc --noEmit
yarn test       # typecheck + native node:test suite
yarn build      # tsc -> dist/
yarn run check  # lint + format:check + typecheck
```

CI (`.github/workflows/ci.yml`) runs lint, format check, typecheck, tests, and build on
every push and pull request, plus [gitleaks](https://github.com/gitleaks/gitleaks)
to guard against committed secrets.

## Security notes

- The private keys and `.env` are git-ignored — do not commit them.
- Credentials are read from the environment, never hardcoded.
- CI scans every change with gitleaks to catch accidentally committed secrets.

#### Resumable derivative order graphs

`submitDerivativeOrderGraph(...)` is the bounded (one through eight member) bracket API for
broker-hosted derivative protection. A graph may combine atomic two-leg LIMIT combos with
single-option LIMIT, STOP, and MARKET members. Every node has a caller-stable `memberId`; exactly
one root carries `rootClientOrderId`. Each later node uses `parentMemberId` to name a member that
comes before it. IBKR receives a deterministic `cOID` for every node. A non-root node also receives
the deterministic `parentId` of its exact parent. This means that a graph can contain children,
grandchildren, and deeper descendants.
Accepted and fail-closed results retain each node's immutable request evidence (contracts/conids,
signed ratios, side, quantity, TIF, session, and prices), stable depth role, parent member/broker
IDs, and every broker order ID. Conids remain correlation evidence only; callers still own durable
semantic option identity.

Warnings are never acknowledged automatically. A warning result contains a JSON-safe
`continuation` with the exact reply ID, full graph request, and all correlation accumulated so far;
persist it before calling `acknowledgeDerivativeOrderGraphWarning(...)`. Each placement or reply is
attempted once after revalidating the account's authentication and competing-session safety;
chained and unknown warnings remain pending for the caller, and mixed, partial,
duplicated, terminal, malformed, or ambiguous acknowledgements return `recovery_required`. Broker
IDs from ambiguous acknowledgements are retained as uncorrelated responses rather than assigned to
nodes by position. Submission acknowledgements are correlated only by the echoed `local_order_id`
or `cOID`. Nested child acknowledgements under `children` or `childOrders` are flattened before
correlation, so a parent-only top-level array does not hide live child broker IDs.
`accepted` requires one distinct non-null broker order ID for every requested graph member. If any
member still has a null order ID after correlation, the result is `recovery_required` and the reason
names those member IDs. Partial evidence never looks like full acceptance. If IBKR does not echo a
complete and consistent identity for each member, the result is `recovery_required`, and the client
does not assign uncorrelated broker IDs to graph members by position.
A failed synchronous response retains a readable `text` or `warning_message` in
`errors` and recovery reasons when IBKR supplies one.
`recoverDerivativeOrderGraph(...)` reconstructs the exact graph from its root client ID, any
known member broker ID, and terminal evidence keyed by the durable root client ID. It searches
normal active and filtered filled, canceled, and inactive order snapshots before it uses recent
execution evidence. It queries an exact broker ID even if execution history is unavailable. When the
caller supplies a durable broker ID, the exact status read can identify only that member without a
client order ID. The account and broker ID must match, and the complete ticket must match exactly one
requested node. Conflicting identity or listing evidence still fails closed.
It requires complete active and filtered terminal snapshot markers, traverses both nested child
collection aliases, and rejects contradictory aliases within a broker response before correlation.
It correlates the root by the transmitted client ID and its complete ticket. It correlates each
descendant by the deterministic client order ID of its exact parent, plus the contract or complete
combo legs, order type, side, quantity, applicable signed limit or stop price, TIF, and
regular/overnight session. Recovery accepts terminal members when the evidence is
non-ambiguous and complete, preserves broker terminal states for each member, and fails closed when
evidence is partial, duplicated, ambiguous, unknown, includes an unexpected attached order, or cannot
prove required account, broker ID, or parent identity links.
No recoveries involve writes.
Failed terminal snapshot lookups force `recovery_required`; trade-linked members whose exact status
lookup fails remain preserved as uncorrelated evidence instead of being discarded.
This recovery API is the safety boundary: consumers should not bypass it with the private raw request
client.
