#!/usr/bin/env python3
"""
demo_relay_flow.py — Charon USDT Payment Relay: end-to-end integration demo

Walks through the complete lifecycle a developer goes through when integrating
Charon as a USDT payment processor:

  1. Health check                 — verify the relay is live
  2. Register developer account   — get an API key and a payout address
  3. Verify the API key           — confirm authentication works
  4. Create a payment session     — get a TRON deposit address and amount due
     (if CDP keys are set on the server, this step is gated by a $0.01 USDC
      x402 payment signed by the BASE_PRIVATE_KEY wallet)
  5. Send USDT on TRON            — prompted; script polls until forwarded
  6. Final summary                — tx hashes and TronScan links

This script is intentionally verbose — every HTTP request and response is
printed so that the flow is fully visible. It is designed to be run live
while narrating each step.

────────────────────────────────────────────────────────────────────────────────
Environment variables
────────────────────────────────────────────────────────────────────────────────
  Required:
    PAYOUT_ADDRESS      TRON address (T...) where forwarded USDT should land

  Optional:
    WDK_SEED_PHRASE     BIP-39 seed phrase (same one the relay uses). The demo
                        derives the Base wallet from m/44'/60'/0'/0/0 — identical
                        to openclaw-bridge/server.py. Use this if you want to sign
                        with the same wallet the relay holds USDC in.
    BASE_PRIVATE_KEY    0x... raw private key fallback (if WDK_SEED_PHRASE is not
                        set). Any Base wallet holding ≥ $0.01 USDC.
                        Both variables are only needed when the server enforces
                        x402 (CDP_API_KEY_* set). In dev mode they are ignored.
    SERVER_URL          Relay base URL (default: http://localhost:3000)
    WEBHOOK_URL         URL to receive payment status webhooks (default: none)
    PAYMENT_AMOUNT      USDT amount to request (default: 2.00)
    ADMIN_KEY           X-Admin-Key for /admin/status (default: value in .env)

────────────────────────────────────────────────────────────────────────────────
Dependencies
────────────────────────────────────────────────────────────────────────────────
  pip install requests eth-account python-dotenv

────────────────────────────────────────────────────────────────────────────────
Example
────────────────────────────────────────────────────────────────────────────────
  PAYOUT_ADDRESS=TYour...TronAddress \\
  BASE_PRIVATE_KEY=0x... \\
  python3 demo_relay_flow.py
"""

import base64
import json
import os
import secrets
import sys
import time
from pathlib import Path

import requests

# Load .env from the same directory as this script (same file Node.js uses)
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass  # dotenv not installed — rely on shell environment

# ── Colour helpers ────────────────────────────────────────────────────────────
# ANSI codes only — no third-party library needed.

RESET  = "\033[0m"
BOLD   = "\033[1m"
GREEN  = "\033[32m"
YELLOW = "\033[33m"
CYAN   = "\033[36m"
RED    = "\033[31m"
DIM    = "\033[2m"


def banner(text: str) -> None:
    width = 72
    print()
    print(CYAN + BOLD + "─" * width + RESET)
    print(CYAN + BOLD + f"  {text}" + RESET)
    print(CYAN + BOLD + "─" * width + RESET)


def step(number: int, title: str) -> None:
    print()
    print(BOLD + f"[ Step {number} ]  {title}" + RESET)


def req_line(method: str, url: str) -> None:
    print(DIM + f"  →  {method} {url}" + RESET)


def ok(msg: str) -> None:
    print(GREEN + BOLD + f"  ✓  {msg}" + RESET)


def info(msg: str) -> None:
    print(YELLOW + f"  ·  {msg}" + RESET)


def error(msg: str) -> None:
    print(RED + BOLD + f"  ✗  {msg}" + RESET)


def pretty(data) -> str:
    return json.dumps(data, indent=2)


def pause(prompt: str = "Press Enter to continue...") -> None:
    print()
    input(DIM + f"  [ {prompt} ]" + RESET + "  ")


def die(msg: str) -> None:
    error(msg)
    sys.exit(1)


# ── Config ────────────────────────────────────────────────────────────────────

SERVER       = os.environ.get("SERVER_URL",      "http://localhost:3000").rstrip("/")
PAYOUT_ADDR  = os.environ.get("PAYOUT_ADDRESS",  "TPL3f1Qe2dfTp9iLPgeLuQEqPAnBPhBHQJ")
WEBHOOK_URL  = os.environ.get("WEBHOOK_URL",     "https://webhook.site/998ec698-c197-491c-bf0a-e7524656a984")
AMOUNT       = os.environ.get("PAYMENT_AMOUNT",  "1.00")
ADMIN_KEY    = os.environ.get("ADMIN_KEY") or os.environ.get("ADMIN_API_KEY", "")
# Wallet for x402 signing — prefers the shared seed phrase (same derivation as the
# bridge and TypeScript relay: m/44'/60'/0'/0/0). Falls back to a raw private key.
WDK_SEED     = os.environ.get("WDK_SEED_PHRASE", "")
BASE_KEY     = os.environ.get("BASE_PRIVATE_KEY", "")

if not PAYOUT_ADDR:
    die("Set PAYOUT_ADDRESS to a TRON T-address where forwarded USDT should land.\n"
        "  Example:  PAYOUT_ADDRESS=TYourTronAddress python3 demo_relay_flow.py")


# ── x402 signing (mirrors openclaw-bridge/server.py exactly) ──────────────────

# USDC on Base — hardcoded as per the x402 spec for this deployment
_USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
_BASE_CHAIN_ID = 8453


def _get_account():
    """Return an eth_account Account, derived from WDK_SEED_PHRASE (preferred)
    or BASE_PRIVATE_KEY. Returns None if neither is set."""
    from eth_account import Account  # noqa: PLC0415
    if WDK_SEED:
        Account.enable_unaudited_hdwallet_features()
        return Account.from_mnemonic(WDK_SEED, account_path="m/44'/60'/0'/0/0")
    if BASE_KEY:
        return Account.from_key(BASE_KEY)
    return None


def _sign_eip3009(account, pay_to: str, amount_units: int, asset: str) -> dict:
    """Sign an EIP-3009 TransferWithAuthorization for USDC on Base.

    Uses account.sign_typed_data() — the modern eth_account API.
    The server (Charon relay / ClawRouter) submits the authorization on-chain;
    the sender never broadcasts a transaction directly.
    """
    nonce_bytes  = secrets.token_bytes(32)
    valid_after  = 0
    valid_before = int(time.time()) + 300  # 5-minute window, same as bridge

    domain_data = {
        "name":              "USD Coin",
        "version":           "2",
        "chainId":           _BASE_CHAIN_ID,
        "verifyingContract": asset,
    }
    message_types = {
        "TransferWithAuthorization": [
            {"name": "from",        "type": "address"},
            {"name": "to",          "type": "address"},
            {"name": "value",       "type": "uint256"},
            {"name": "validAfter",  "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce",       "type": "bytes32"},
        ],
    }
    message_data = {
        "from":        account.address,
        "to":          pay_to,
        "value":       amount_units,
        "validAfter":  valid_after,
        "validBefore": valid_before,
        "nonce":       nonce_bytes,
    }

    if hasattr(account, "sign_typed_data"):
        # eth_account >= 0.9.0
        signed = account.sign_typed_data(
            domain_data=domain_data,
            message_types=message_types,
            message_data=message_data,
        )
    else:
        # eth_account < 0.9.0 — use encode_structured_data
        from eth_account.structured_data import encode_structured_data  # noqa: PLC0415
        structured = {
            "types": {
                "EIP712Domain": [
                    {"name": "name",              "type": "string"},
                    {"name": "version",           "type": "string"},
                    {"name": "chainId",           "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"},
                ],
                **message_types,
            },
            "primaryType": "TransferWithAuthorization",
            "domain":      domain_data,
            "message":     {**message_data, "nonce": "0x" + nonce_bytes.hex()},
        }
        signed = account.sign_message(encode_structured_data(structured))

    return {
        "signature": "0x" + signed.signature.hex(),
        "authorization": {
            "from":        account.address,
            "to":          pay_to,
            "value":       str(amount_units),
            "validAfter":  str(valid_after),
            "validBefore": str(valid_before),
            "nonce":       "0x" + nonce_bytes.hex(),
        },
    }


def _parse_amount_units(raw: str) -> int:
    """Convert maxAmountRequired to USDC base units (6 decimals).

    The server may send either:
      - a dollar string like "0.01"  → multiply by 1_000_000
      - a base-unit integer string like "10000" → use directly
    Heuristic: if the value contains a dot or is < 1000, treat as dollars.
    """
    val = float(raw)
    if "." in raw or val < 1000:
        return round(val * 1_000_000)
    return int(val)


def build_x402_header(req: dict, account) -> str:
    """Build the base64-encoded X-Payment header from a 402 requirement dict."""
    payload = _sign_eip3009(
        account,
        pay_to       = req["payTo"],
        amount_units = _parse_amount_units(req["maxAmountRequired"]),
        asset        = req.get("asset", _USDC_BASE),
    )
    payment = {
        "x402Version": 1,
        "scheme":      req["scheme"],
        "network":     req["network"],
        "payload":     payload,
    }
    return base64.b64encode(json.dumps(payment).encode()).decode()


def create_payment_with_x402(dev_api_key: str, body: dict) -> dict:
    """POST /payment/create with x402 two-round-trip handling.

    Round 1 → if 402, sign EIP-3009, attach X-Payment header, retry.
    Round 1 → if 200, server is in dev mode (CDP keys not set).
    """
    headers = {"Content-Type": "application/json", "X-Api-Key": dev_api_key}
    url = f"{SERVER}/payment/create"

    info("Sending initial request...")
    req_line("POST", url)
    r = requests.post(url, json=body, headers=headers, timeout=15)

    if r.status_code in (200, 201):
        info("Server is in dev mode — x402 gate bypassed (CDP keys not set).")
        return r.json()

    if r.status_code != 402:
        die(f"Unexpected status {r.status_code}: {r.text}")

    # ── 402 received ──────────────────────────────────────────────────────────
    print()
    info("402 Payment Required — x402 gate is active.")
    requirements = r.json()
    print(DIM + pretty(requirements) + RESET)

    # Find the first 'exact' + 'base' requirement (same logic as the bridge)
    accepts_list = requirements.get("accepts", [])
    req = next(
        (a for a in accepts_list
         if a.get("scheme") == "exact" and "base" in a.get("network", "").lower()),
        None,
    )
    if req is None:
        die("No supported payment requirement found in 402 response (need exact + base).")

    amount_usdc = float(req["maxAmountRequired"])
    info(f"Payment required: ${amount_usdc:.6f} USDC → {req['payTo']} on Base")

    account = _get_account()
    if account is None:
        die(
            "No signing wallet available. Set WDK_SEED_PHRASE (preferred) or\n"
            "  BASE_PRIVATE_KEY to a Base wallet holding ≥ $0.01 USDC.\n"
            "  Or run the server without CDP_API_KEY_* to bypass x402."
        )

    info(f"Signing with wallet: {account.address}")
    info("Signing EIP-3009 TransferWithAuthorization...")
    x_payment = build_x402_header(req, account)
    ok("Signed. Retrying with X-Payment header...")

    retry_headers = {**headers, "X-Payment": x_payment}
    req_line("POST", url + "  [with X-Payment]")
    r2 = requests.post(url, json=body, headers=retry_headers, timeout=15)

    if r2.status_code not in (200, 201):
        die(f"Payment rejected ({r2.status_code}): {r2.text}")

    return r2.json()


# ═════════════════════════════════════════════════════════════════════════════
# Main demo flow
# ═════════════════════════════════════════════════════════════════════════════

banner("CHARON — USDT Payment Relay  ·  End-to-End Developer Demo")
print(f"  Server  : {SERVER}")
print(f"  Payout  : {PAYOUT_ADDR}")
print(f"  Amount  : {AMOUNT} USDT")
_wallet_src = "WDK_SEED_PHRASE (BIP-44)" if WDK_SEED else ("BASE_PRIVATE_KEY" if BASE_KEY else "none — dev mode only")
print(f"  x402    : {_wallet_src}")

pause("Ready to begin")

# ── Step 1: Health check ──────────────────────────────────────────────────────

step(1, "Health check  →  /admin/status")

r = requests.get(f"{SERVER}/admin/status", headers={"X-Admin-Key": ADMIN_KEY}, timeout=15)
if r.status_code != 200:
    die(f"/admin/status returned {r.status_code}. Is the relay running?")

status = r.json()
print(pretty(status))

bal = status.get("balances", {})
ok(f"Relay is live.")
info(f"TRON USDT (liquid)  : {bal.get('tronUsdtLiquid', '?')} USDT")
info(f"Aave deposited      : {bal.get('aaveUsdtDeposited', '?')} USDT  (APY {bal.get('aaveApy', '?')}%)")
info(f"TRX gas reserve     : {bal.get('trxReserve', '?')} TRX")
info(f"Runway              : {status.get('runway', {}).get('runwayDays', '?')} days")

pause()

# ── Step 2: Register developer account ───────────────────────────────────────

step(2, "Register developer account  →  POST /developer/register")

reg_body = {
    "receivingAddress": PAYOUT_ADDR,
    "payoutChain":      "tron",
}
if WEBHOOK_URL:
    reg_body["webhookUrl"]    = WEBHOOK_URL
    reg_body["webhookSecret"] = "demo-secret-at-least-16"

info("Registering...")
req_line("POST", f"{SERVER}/developer/register")
print(DIM + pretty(reg_body) + RESET)

r = requests.post(f"{SERVER}/developer/register", json=reg_body, timeout=10)
if r.status_code not in (200, 201):
    die(f"Registration failed ({r.status_code}): {r.text}")

reg = r.json()
print(pretty(reg))

dev_id  = reg["developerId"]
api_key = reg["apiKey"]

ok(f"Registered!  Developer ID: {dev_id}")
info("The API key is shown once only — store it securely.")
info(f"API key: {api_key}")

pause()

# ── Step 3: Verify API key ────────────────────────────────────────────────────

step(3, "Verify API key  →  GET /developer/me")

req_line("GET", f"{SERVER}/developer/me")
r = requests.get(f"{SERVER}/developer/me", headers={"X-Api-Key": api_key}, timeout=10)

if r.status_code != 200:
    die(f"Auth check failed ({r.status_code}): {r.text}")

profile = r.json()
print(pretty(profile))
ok("API key is valid.")

pause()

# ── Step 4: Create payment session ────────────────────────────────────────────

step(4, "Create payment session  →  POST /payment/create")

pay_body = {
    "amount":           AMOUNT,
    "currency":         "USDT",
    "orderId":          f"demo-{int(time.time())}",
    "expiresInMinutes": 30,
}

info(f"Requesting a deposit address for {AMOUNT} USDT...")
print(DIM + pretty(pay_body) + RESET)
print()

payment = create_payment_with_x402(api_key, pay_body)
print(pretty(payment))

pay_id     = payment["id"]
pay_addr   = payment["address"]
amount_due = payment["amountDue"]

print()
ok(f"Payment session created!")
info(f"Payment ID      : {pay_id}")
info(f"Deposit address : {pay_addr}   ← send USDT here")
info(f"Amount due      : {amount_due} USDT  (includes relay fee + energy sponsorship)")
info(f"Amount net      : {payment['amountNet']} USDT  (what you receive after fees)")
info(f"Relay fee       : {payment.get('relayFeePercent', '?')}%")
info(f"Gasless         : {payment.get('gasless', False)}  (TRX energy sponsored — sender pays zero gas)")
info(f"Expires at      : {payment['expiresAt']}")

pause()

# ── Step 5: Wait for USDT ─────────────────────────────────────────────────────

step(5, "Send USDT on TRON — then watch it get forwarded")

print()
print(BOLD + YELLOW + "  ┌──────────────────────────────────────────────────────────┐" + RESET)
print(BOLD + YELLOW + f"  │  Send exactly  {amount_due} USDT TRC-20" + RESET)
print(BOLD + YELLOW + f"  │  to:  {pay_addr}" + RESET)
print(BOLD + YELLOW + "  │" + RESET)
print(BOLD + YELLOW + "  │  TronLink, Exodus, CEX withdrawal, or any Tron wallet." + RESET)
print(BOLD + YELLOW + "  │  The exact amount matters — the relay will reject under-payments." + RESET)
print(BOLD + YELLOW + "  └──────────────────────────────────────────────────────────┘" + RESET)
print()
print(f"  TronScan address: https://tronscan.org/#/address/{pay_addr}")
print()

pause("Send the USDT now, then press Enter to start polling")

# ── Step 5b: Poll status ──────────────────────────────────────────────────────

print()
print(CYAN + BOLD + "  Polling for payment..." + RESET)
print(YELLOW + f"  Waiting for  {amount_due} USDT  →  {pay_addr}" + RESET)
print(DIM + "  (checks every 3 s — ctrl-C to abort)" + RESET)
print()

status_url    = f"{SERVER}/payment/{pay_id}/status"
terminal      = {"forwarded", "failed", "expired"}
last_status   = None
poll_count    = 0
MAX_POLLS     = 200  # ~10 minutes

while poll_count < MAX_POLLS:
    r = requests.get(status_url, timeout=10)
    data = r.json()
    current = data.get("status", "unknown")
    poll_count += 1
    ts = time.strftime("%H:%M:%S")

    if current != last_status:
        status_descriptions = {
            "pending":   "waiting for USDT to arrive on-chain...",
            "detected":  "transfer seen on-chain — accumulating confirmations...",
            "confirmed": "3 confirmations reached — sweeping now...",
            "forwarded": "USDT forwarded to your receiving address!",
            "failed":    "something went wrong — check /admin/logs",
            "expired":   "payment window expired",
        }
        desc = status_descriptions.get(current, current)
        colour = GREEN if current == "forwarded" else (RED if current in ("failed", "expired") else YELLOW)
        print(f"  [{ts}]  {colour}{BOLD}{current.upper()}{RESET}  —  {desc}")
        last_status = current
    else:
        # Show a live tick so the user can see polling is active
        print(f"  {DIM}[{ts}]  {current}  (poll #{poll_count}){RESET}", end="\r", flush=True)

    if current in terminal:
        print()  # clear the \r line
        break

    time.sleep(3)
else:
    print()
    info("Timed out after 10 minutes. Check status manually.")
    sys.exit(1)

# ── Step 6: Summary ───────────────────────────────────────────────────────────

step(6, "Summary")
print(pretty(data))

if data.get("status") == "forwarded":
    tx = data.get("txHash") or data.get("sweepTxHash") or "see /admin/logs"
    print()
    ok("Payment complete!")
    info(f"Forwarding tx : {tx}")
    if tx and tx.startswith("0") or (tx and len(tx) > 10):
        info(f"TronScan      : https://tronscan.org/#/transaction/{tx}")
    info(f"Your wallet   : https://tronscan.org/#/address/{PAYOUT_ADDR}")
    print()
    info("The relay fee went to Charon's TRON wallet.")
    info("Idle capital will be deposited to Aave at the next board meeting.")
    info("The board meeting is paid for in USDC on Base via x402 — autonomous inference.")
elif data.get("status") == "failed":
    error("Payment failed. Check the relay logs:")
    print(f"  curl '{SERVER}/admin/logs?category=PAYMENT&limit=10'")
    print(f"       -H 'X-Admin-Key: {ADMIN_KEY}' | python3 -m json.tool")
