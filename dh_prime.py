"""Extract the Diffie-Hellman prime (hex) from a dhparam.pem file.

IBKR's OAuth 1.0a live-session-token exchange needs the DH prime as a
continuous hex string. Rather than hardcoding it, we derive it from
dhparam.pem at runtime via OpenSSL.
"""

import re
import subprocess
from pathlib import Path


def extract_dh_prime(dhparam_path: str | Path = "dhparam.pem") -> str:
    """Return the DH prime from dhparam.pem as a lowercase hex string."""
    result = subprocess.run(
        ["openssl", "dhparam", "-in", str(dhparam_path), "-text"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    match = re.search(r"(?:prime|P):\s*((?:\s*[0-9a-fA-F:]+\s*)+)", result)
    if not match:
        raise ValueError(f"No DH prime (P) value found in {dhparam_path}")
    return re.sub(r"[\s:]", "", match.group(1))


if __name__ == "__main__":
    print(extract_dh_prime())
