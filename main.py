"""PoC: connect to the IBKR Web API over OAuth 1.0a and pull sample portfolio data.

Uses the `ibind` library (https://github.com/Voyz/ibind). OAuth 1.0a removes the
need to run the Client Portal Gateway — `ibind` performs the live-session-token
handshake directly against IBKR's REST endpoint.

Credentials come from two places:
  * The cryptographic material (private keys + DH prime) lives as files in this
    directory and is wired up automatically below.
  * The account-specific secrets (consumer key, access token + secret) are read
    from environment variables / a local .env file.

Run:  python main.py
"""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from ibind import IbkrClient
from ibind.oauth.oauth1a import OAuth1aConfig

from dh_prime import extract_dh_prime

HERE = Path(__file__).resolve().parent


def build_client() -> IbkrClient:
    """Assemble an OAuth-authenticated IbkrClient from local files + env vars."""
    load_dotenv(HERE / ".env")

    required = (
        "IBIND_OAUTH1A_CONSUMER_KEY",
        "IBIND_OAUTH1A_ACCESS_TOKEN",
        "IBIND_OAUTH1A_ACCESS_TOKEN_SECRET",
    )
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        sys.exit(
            "Missing required environment variables:\n  "
            + "\n  ".join(missing)
            + "\n\nCopy .env.example to .env and fill them in (or export them)."
        )

    oauth_config = OAuth1aConfig(
        consumer_key=os.environ["IBIND_OAUTH1A_CONSUMER_KEY"],
        access_token=os.environ["IBIND_OAUTH1A_ACCESS_TOKEN"],
        access_token_secret=os.environ["IBIND_OAUTH1A_ACCESS_TOKEN_SECRET"],
        signature_key_fp=str(HERE / "private_signature.pem"),
        encryption_key_fp=str(HERE / "private_encryption.pem"),
        dh_prime=extract_dh_prime(HERE / "dhparam.pem"),
    )

    return IbkrClient(use_oauth=True, oauth_config=oauth_config)


def main() -> None:
    client = build_client()

    print("→ Checking authentication status...")
    auth = client.authentication_status().data
    print(f"  authenticated={auth.get('authenticated')} competing={auth.get('competing')}")

    print("\n→ Portfolio accounts:")
    accounts = client.portfolio_accounts().data
    for acct in accounts:
        print(f"  {acct.get('accountId')}  ({acct.get('type')}, {acct.get('currency')})")

    account_id = os.getenv("IBKR_ACCOUNT_ID") or accounts[0]["accountId"]
    print(f"\n→ Using account: {account_id}")

    print("\n→ Account summary:")
    summary = client.portfolio_summary(account_id).data
    for key in ("netliquidation", "availablefunds", "buyingpower", "totalcashvalue"):
        field = summary.get(key)
        if field:
            print(f"  {key}: {field.get('amount')} {field.get('currency')}")

    print("\n→ Positions (first page):")
    positions = client.positions(account_id, page=0).data
    if not positions:
        print("  (no open positions)")
    for pos in positions:
        print(
            f"  {pos.get('contractDesc'):<12} "
            f"qty={pos.get('position')} "
            f"mktValue={pos.get('mktValue')} {pos.get('currency')}"
        )


if __name__ == "__main__":
    main()
