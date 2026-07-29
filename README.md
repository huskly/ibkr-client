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

| Path                         | Purpose                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `src/types.ts`               | Broker-neutral `BrokerClient` interface and normalized domain types         |
| `src/ibkr/ibkrClient.ts`     | `IbkrClient` — typed wrapper over `ibkr-client` implementing `BrokerClient` |
| `src/ibkr/oauthConfig.ts`    | Builds the OAuth config from `.pem` files + env vars                        |
| `src/ibkr/dhPrime.ts`        | Extracts the DH prime (hex) from `dhparam.pem`                              |
| `src/ibkr/optionContract.ts` | Canonical OSI parsing and formatting for IBKR option contracts              |
| `src/ibkr/derivativeContract.ts` | Normalizes OPT/FOP identity and market-data availability              |

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
routing, and caching. Its broker-neutral account API includes:

- `getAccountBalances()` and `getPositions()` for account state.
- `getQuotes()` and `searchInstruments()` for equity/ETF discovery and quotes.
- `fetchTransactionHistory()` for normalized portfolio transactions.
- `fetchOrders()` for normalized live orders, including aggregate `WORKING`
  matching across IBKR's active order states.

### Strategy market data

The reusable `IbkrClient` also exposes typed, read-only strategy data:

- `getPriceHistory(...)` returns normalized OHLCV bars.
- `getOptionExpiries(...)` discovers weekly and monthly maturities across month buckets.
- `getOptionChain(...)` returns an exact-expiry chain with canonical OSI symbols, conids,
  bid/ask/mid prices, delta, session volume, and open interest.
- `getOptionQuote(...)` resolves and prices one exact contract with the same market-data shape.
- `getOptionContract(conid)` maps a broker conid back to durable OSI identity.

### Broker-neutral derivative discovery

`IbkrClient` implements the capability-specific `DerivativeDiscoveryClient` without adding
derivative operations to the smaller account-oriented `BrokerClient`:

- `getDerivativeExpiries(...)` lists exact series identity over a calendar range.
- `getDerivativeContracts(...)` discovers all matching contracts for one expiration.
- `resolveDerivativeContract(...)` returns exactly one contract and rejects ambiguous trading
  classes.
- `getDerivativeChain(...)` prices one exact expiration and fails when no usable bid/ask exists.

Both `OPT` and `FOP` use the stateful `secdef/search` -> `secdef/strikes` -> `secdef/info`
sequence. FOP discovery derives a unique exchange such as CME from the search result when the
caller does not provide one. Index-option callers can select a venue explicitly, such as SMART.

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

Contract discovery always calls `secdef/search` before `secdef/strikes`, because IBKR keeps
that priming state in the authenticated session. Empty post-prime strikes and incomplete
bid/ask/delta snapshots throw instead of looking like a valid chain with no candidates.
Request shaping is resilient by design: option discovery normalizes the requested symbol,
applies bounded batching for secondary-definition and market-data calls, and retries read-only
requests on transient `429` responses with capped exponential backoff (including `Retry-After`
headers when available). If every returned contract is unusable (missing bid/ask/delta), the
client now fails noisily so callers can handle that condition explicitly.
Option volume and open interest are required nullable fields: numeric zero remains zero, while
missing, unsupported, or non-finite provider values are returned as `null`.
Conids are broker-boundary identifiers; consumers should persist the returned OSI `symbol`.

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
const chain = await client.getOptionChain(symbol, expiry);
console.log({ equityRead: Number.isFinite(balances.netLiquidation), historyBars: history.length,
  expiry, contracts: chain.length, first: chain[0]?.symbol });
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
