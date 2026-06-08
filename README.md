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

## Development

```bash
npm run lint          # eslint
npm run format        # prettier --write
npm run typecheck     # tsc --noEmit
npm run build         # tsc -> dist/
npm run check         # lint + format:check + typecheck
```

CI (`.github/workflows/ci.yml`) runs lint, format check, typecheck, and build on
every push and pull request, plus [gitleaks](https://github.com/gitleaks/gitleaks)
to guard against committed secrets.

## Security notes

- The private keys and `.env` are git-ignored — do not commit them.
- Credentials are read from the environment, never hardcoded.
- CI scans every change with gitleaks to catch accidentally committed secrets.
