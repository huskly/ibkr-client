# IBKR OAuth 1.0a PoC

A minimal proof-of-concept that connects to the **Interactive Brokers Web API**
using **OAuth 1.0a** (no Client Portal Gateway required) and pulls sample
portfolio information.

Built on [`ibind`](https://github.com/Voyz/ibind). See the
[OAuth 1.0a setup wiki](https://github.com/Voyz/ibind/wiki/OAuth-1.0a) for how
the keys below are generated and registered in the IBKR self-service portal.

## What's here

| File | Purpose |
| --- | --- |
| `main.py` | The PoC — authenticates and prints accounts, summary, and positions |
| `dh_prime.py` | Extracts the Diffie-Hellman prime (hex) from `dhparam.pem` |
| `*.pem` | Cryptographic material (already present, git-ignored) |
| `.env.example` | Template for the runtime secrets |

The `.pem` files (`private_signature.pem`, `private_encryption.pem`,
`public_*.pem`, `dhparam.pem`) are the keys from the wiki setup step and are
picked up automatically. The DH prime is derived from `dhparam.pem` at runtime,
so you never need to copy it by hand.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
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

Optionally set `IBKR_ACCOUNT_ID` to target a specific account (otherwise the
first account returned is used).

## Run

```bash
.venv/bin/python main.py
```

Expected output (with valid credentials):

```
→ Checking authentication status...
  authenticated=True competing=False

→ Portfolio accounts:
  U1234567  (INDIVIDUAL, USD)

→ Using account: U1234567

→ Account summary:
  netliquidation: 12345.67 USD
  ...

→ Positions (first page):
  AAPL         qty=10 mktValue=1900.0 USD
  ...
```

## Security notes

- The private keys and `.env` are git-ignored — do not commit them.
- Credentials are read from the environment, never hardcoded.
