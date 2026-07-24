# IBKR CLI (`@huskly/ibkr-client`)

A terminal trading CLI for the **Interactive Brokers Web API**, authenticating
over **OAuth 1.0a** (no Client Portal Gateway required). Built to mirror the
architecture of [huskly-cli](https://github.com/felipecsl/huskly-cli) so the two
can merge into a single multi-broker CLI (IBKR + Schwab) over time.

The OAuth 1.0a live-session-token handshake is performed by the
[`ibkr-client`](https://github.com/art1c0/ibkr-client) package. See the
[`ibind` OAuth 1.0a wiki](https://github.com/Voyz/ibind/wiki/OAuth-1.0a) for how
the keys below are generated and registered in the IBKR self-service portal.

## Layout

The repo is split into a reusable **library** and a thin **CLI**, mirroring
huskly-cli's `@huskly/schwab-client` + CLI split:

| Path                     | Purpose                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `src/types.ts`           | Broker-neutral `BrokerClient` interface + domain types (the merge contract) |
| `src/ibkr/ibkrClient.ts` | `IbkrClient` — typed wrapper over `ibkr-client` implementing `BrokerClient` |
| `src/ibkr/oauthConfig.ts`| Builds the OAuth config from `.pem` files + env vars                      |
| `src/ibkr/dhPrime.ts`    | Extracts the DH prime (hex) from `dhparam.pem`                            |
| `src/ibkr/optionContract.ts` | Canonical OSI parsing and formatting for IBKR option contracts        |
| `src/cli/`               | `commander` program, `--broker` flag, and command handlers               |

The `*.pem` files (`private_signature.pem`, `private_encryption.pem`,
`dhparam.pem`, plus the public keys) are the cryptographic material from the
wiki setup step and are git-ignored.

## Setup

```bash
npm install
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

## Usage

Run in development (via `tsx`, no build step):

```bash
npm run dev -- account
npm run dev -- positions
npm run dev -- positions AAPL          # filter by symbol
npm run dev -- positions --type EQUITY # filter by asset type
npm run dev -- positions --csv         # CSV instead of a table
```

Or build and use the `ibkr-cli` binary:

```bash
npm run build
node dist/cli/index.js account
```

A global `--broker <ibkr|schwab>` flag (default `ibkr`) selects the broker.
Only IBKR is implemented today; `schwab` is reserved for the huskly-cli merge.

Example output:

```
💰 Account Summary

Authenticated: yes   Competing: no
Account:       U********
──────────────────────────────────────────────────
Net Liquidation:  $123,456.78
Available Funds:  $...
...
```

## Strategy market data

The reusable `IbkrClient` also exposes typed, read-only strategy data:

- `getPriceHistory(...)` returns normalized OHLCV bars.
- `getOptionExpiries(...)` discovers weekly and monthly maturities across month buckets.
- `getOptionChain(...)` returns an exact-expiry chain with canonical OSI symbols, conids,
  bid/ask/mid prices, and delta.
- `getOptionQuote(...)` resolves and prices one exact contract.
- `getOptionContract(conid)` maps a broker conid back to durable OSI identity.

Contract discovery always calls `secdef/search` before `secdef/strikes`, because IBKR keeps
that priming state in the authenticated session. Empty post-prime strikes and incomplete
bid/ask/delta snapshots throw instead of looking like a valid chain with no candidates.
Request shaping is resilient by design: option discovery normalizes the requested symbol,
applies bounded batching for secondary-definition and market-data calls, and retries read-only
requests on transient `429` responses with capped exponential backoff (including `Retry-After`
headers when available). If every returned contract is unusable (missing bid/ask/delta), the
client now fails noisily so callers can handle that condition explicitly.
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
npm run lint          # eslint
npm run format        # prettier --write
npm run typecheck     # tsc --noEmit
npm test              # typecheck + native node:test suite
npm run build         # tsc -> dist/
npm run check         # lint + format:check + typecheck
```

CI (`.github/workflows/ci.yml`) runs lint, format check, typecheck, tests, and build on
every push and pull request, plus [gitleaks](https://github.com/gitleaks/gitleaks)
to guard against committed secrets.

## Security notes

- The private keys and `.env` are git-ignored — do not commit them.
- Credentials are read from the environment, never hardcoded.
- CI scans every change with gitleaks to catch accidentally committed secrets.
