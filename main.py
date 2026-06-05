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
import time
from pathlib import Path

from dotenv import load_dotenv

from ibind import IbkrClient
from ibind.oauth.oauth1a import OAuth1aConfig

from dh_prime import extract_dh_prime

HERE = Path(__file__).resolve().parent

# ANSI colors for terminal output.
RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
RED = "\033[31m"
GREEN = "\033[32m"
CYAN = "\033[36m"

# IBKR asset-class codes -> human-readable type labels.
ASSET_CLASS_LABELS = {
    "STK": "EQUITY",
    "OPT": "OPTION",
    "FOP": "FUTURES OPTION",
    "FUT": "FUTURE",
    "FUND": "COLLECTIVE_INVESTMENT",
    "BOND": "BOND",
    "WAR": "WARRANT",
    "CASH": "FOREX",
    "CFD": "CFD",
}

# Live market-data snapshot field 78 = position's P&L for the current day.
DAY_PNL_FIELD = "78"


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


def _color(text: str, code: str) -> str:
    return f"{code}{text}{RESET}"


def _pnl_color(value: float | None) -> str:
    """Green for non-negative P&L, red for losses."""
    return RED if (value or 0) < 0 else GREEN


def fmt_money(value: float | None, signed: bool = False) -> str:
    """Format a dollar amount. ``signed`` forces a leading +/- (for P&L)."""
    if value is None:
        return "-"
    sign = "-" if value < 0 else ("+" if signed else "")
    return f"{sign}${abs(value):,.2f}"


def fmt_pct(value: float | None) -> str:
    if value is None:
        return "-"
    sign = "-" if value < 0 else "+"
    return f"{sign}{abs(value):.2f}%"


def fetch_all_positions(client: IbkrClient, account_id: str) -> list[dict]:
    """Page through the positions endpoint until it stops returning rows."""
    out: list[dict] = []
    page = 0
    while True:
        rows = client.positions(account_id, page=page).data
        if not rows:
            break
        out.extend(rows)
        page += 1
    return out


def fetch_day_pnl(client: IbkrClient, conids: list[str]) -> dict[int, float]:
    """Return {conid: day P&L}. Snapshots need a warm-up call before data lands."""
    if not conids:
        return {}
    client.live_marketdata_snapshot(conids, [DAY_PNL_FIELD])  # subscribe / warm up
    time.sleep(2)
    snapshot = client.live_marketdata_snapshot(conids, [DAY_PNL_FIELD]).data
    day_pnl: dict[int, float] = {}
    for row in snapshot:
        raw = row.get(f"{DAY_PNL_FIELD}_raw")
        if raw is not None:
            day_pnl[row.get("conid")] = float(raw)
    return day_pnl


def render_positions(client: IbkrClient, account_id: str) -> None:
    positions = fetch_all_positions(client, account_id)
    print(_color(f"\n{BOLD}Account Positions{RESET}", ""))
    if not positions:
        print("  (no open positions)")
        return

    day_pnl = fetch_day_pnl(client, [str(p["conid"]) for p in positions])

    headers = [
        "Symbol", "Type", "Long", "Short", "Avg Price", "Cur Price",
        "Mkt Value", "Day P/L", "P/L Open", "P/L %",
    ]
    # Right-align everything except Symbol and Type.
    left_aligned = {0, 1}

    rows: list[list[tuple[str, str]]] = []  # each cell is (text, color)
    for p in positions:
        qty = p.get("position") or 0.0
        avg = p.get("avgPrice")
        mult = float(p.get("multiplier") or 1)
        upnl = p.get("unrealizedPnl")
        cost_basis = (avg or 0) * abs(qty) * mult
        pl_pct = (upnl / cost_basis * 100) if (upnl is not None and cost_basis) else None
        dpnl = day_pnl.get(p.get("conid"))
        asset = p.get("assetClass")

        rows.append([
            (p.get("contractDesc") or str(p.get("conid")), CYAN),
            (ASSET_CLASS_LABELS.get(asset, asset or "-"), ""),
            (f"{qty:g}" if qty > 0 else "-", GREEN),
            (f"{abs(qty):g}" if qty < 0 else "-", RED),
            (fmt_money(avg), ""),
            (fmt_money(p.get("mktPrice")), ""),
            (fmt_money(p.get("mktValue")), _pnl_color(p.get("mktValue"))),
            (fmt_money(dpnl, signed=True), _pnl_color(dpnl)),
            (fmt_money(upnl, signed=True), _pnl_color(upnl)),
            (fmt_pct(pl_pct), _pnl_color(pl_pct)),
        ])

    # Column widths from raw (uncolored) cell text.
    widths = [len(h) for h in headers]
    for row in rows:
        for i, (text, _) in enumerate(row):
            widths[i] = max(widths[i], len(text))

    def pad(text: str, i: int) -> str:
        return text.ljust(widths[i]) if i in left_aligned else text.rjust(widths[i])

    gap = "  "
    header_line = gap.join(_color(pad(h, i), DIM) for i, h in enumerate(headers))
    print(header_line)
    print(_color("-" * (sum(widths) + len(gap) * (len(widths) - 1)), DIM))
    for row in rows:
        cells = []
        for i, (text, code) in enumerate(row):
            padded = pad(text, i)
            cells.append(_color(padded, code) if code else padded)
        print(gap.join(cells))


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

    render_positions(client, account_id)


if __name__ == "__main__":
    main()
