#!/usr/bin/env python3
"""openclaw-bridge/server.py

Python HTTP bridge that runs a Claude agent loop using ClawRouter for inference.
ClawRouter is an x402-native OpenAI-compatible router — each inference request
is paid for in USDC on Base, drawn directly from the agent's Base wallet.

This closes the autonomous loop:
  Relay earns USDC on Base (x402 /payment/create fees)
       ↓
  ClawRouter charges USDC on Base per inference call (x402 micropayment)
       ↓
  No credit card, no human, no fiat anywhere.

Architecture:
  TypeScript relay → POST /agent/run → This bridge → ClawRouter (x402 + USDC)
                                                             ↓ tool calls
  TypeScript internal API (/internal/*) ←──────────────────┘

x402 payment flow:
  1. Bridge sends chat completions request to ClawRouter
  2. ClawRouter returns 402 with payment requirements (payTo, amount, asset)
  3. Bridge signs an EIP-3009 transferWithAuthorization using the agent's Base wallet
  4. Bridge retries with X-Payment header containing the signed authorization
  5. ClawRouter submits the on-chain payment and returns the inference result

Environment variables:
  WDK_SEED_PHRASE            - BIP-39 seed phrase (shared with TypeScript relay)
  CLAW_ROUTER_URL            - ClawRouter base URL
                               (see github.com/BlockRunAI/ClawRouter for current URL)
  CLAW_ROUTER_MODEL          - Model alias for standard sessions (default: claude)
  CLAW_ROUTER_MODEL_OPUS     - Model alias for board meetings (default: opus)
  MAX_PAYMENT_PER_CALL_USDC  - Safety ceiling per x402 payment in USD (default: 0.50)
  RELAY_INTERNAL_URL         - TypeScript internal API base URL
                               (default: http://localhost:4000/internal)
  BRIDGE_PORT                - Port to listen on (default: 4001)
"""

import base64
import json
import logging
import os
import sys
import time
import uuid
import secrets as sec_module
from pathlib import Path
from typing import Any

import httpx
import requests
from flask import Flask, request, jsonify

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_SCRIPT_DIR = Path(__file__).parent
AGENT_PATH = Path(os.environ.get("OPENCLAW_AGENT_PATH", str(_SCRIPT_DIR.parent / "agent")))
# MEMORY_PATH lives in the persistent volume so it survives container restarts.
# supervisord sets this to /app/data/MEMORY.md. Falls back to the agent dir
# (template version) if not explicitly set — useful for local dev.
MEMORY_PATH = Path(os.environ.get("MEMORY_PATH", str(AGENT_PATH / "MEMORY.md")))
RELAY_INTERNAL_URL = os.environ.get("RELAY_INTERNAL_URL", "http://localhost:3000/internal")
BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "4001"))

# ClawRouter — x402-native OpenAI-compatible inference router.
# Runs as a sibling process inside the container on port 8402 (see supervisord.conf).
# supervisord sets CLAW_ROUTER_URL=http://localhost:8402/v1 automatically.
# Do NOT use https://api.clawrouter.ai — that hosted endpoint requires account registration.
CLAW_ROUTER_URL = os.environ.get("CLAW_ROUTER_URL", "http://localhost:8402/v1")
# "claude" → ClawRouter routes to claude-sonnet-4.6 (cheap, fast, capable).
# "opus"   → claude-opus-4.6 (~5× more expensive; override via env var if needed).
CLAW_ROUTER_MODEL = os.environ.get("CLAW_ROUTER_MODEL", "claude")
CLAW_ROUTER_MODEL_BOARD = os.environ.get("CLAW_ROUTER_MODEL_BOARD", "claude")

# Optional Bearer token for non-x402 ClawRouter deployments that require one.
# For standard local ClawRouter (port 8402), leave this unset — x402 wallet
# auth is used instead and no Authorization header should be sent.
CLAW_ROUTER_API_KEY = os.environ.get("CLAW_ROUTER_API_KEY") or None


# Safety ceiling: reject any x402 payment requirement above this amount.
MAX_PAYMENT_PER_CALL_USDC = float(os.environ.get("MAX_PAYMENT_PER_CALL_USDC", "0.50"))

# x402 / USDC on Base
USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
BASE_CHAIN_ID = 8453
USDC_DECIMALS = 6

# Per-agent model selection: board meetings use the stronger model.
AGENT_MODELS: dict[str, str] = {
    "main": CLAW_ROUTER_MODEL,
    "board-meeting": CLAW_ROUTER_MODEL_BOARD,
    "decision": CLAW_ROUTER_MODEL,
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="[openclaw-bridge] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# EVM wallet (lazy, derived from WDK_SEED_PHRASE)
# ---------------------------------------------------------------------------

_evm_account = None


def get_evm_account():
    """Derive the agent's Base wallet from the BIP-39 seed phrase.

    Uses path m/44'/60'/0'/0/0 — same derivation as src/wallet/evm.ts.
    Returns None if WDK_SEED_PHRASE is not set (x402 payments disabled).
    """
    global _evm_account
    if _evm_account is not None:
        return _evm_account

    seed = os.environ.get("WDK_SEED_PHRASE", "")
    if not seed:
        log.warning("WDK_SEED_PHRASE not set — x402 payments will fail.")
        return None

    try:
        from eth_account import Account
        Account.enable_unaudited_hdwallet_features()
        _evm_account = Account.from_mnemonic(seed, account_path="m/44'/60'/0'/0/0")
        log.info("x402 wallet: %s", _evm_account.address)
        return _evm_account
    except Exception as exc:
        log.error("Failed to derive EVM wallet: %s", exc)
        return None


# ---------------------------------------------------------------------------
# x402 payment signing
# ---------------------------------------------------------------------------


def _sign_eip3009(account, pay_to: str, amount_units: int, asset: str) -> dict:
    """Sign an EIP-3009 transferWithAuthorization for USDC on Base.

    Returns the authorization dict and signature for inclusion in the
    X-Payment header. The server (ClawRouter) submits this on-chain.

    Args:
        account:      eth_account Account object (agent's Base wallet)
        pay_to:       Recipient address (ClawRouter's settlement address)
        amount_units: Amount in USDC's smallest unit (6 decimals). E.g. 30000 = $0.03
        asset:        USDC contract address on Base
    """
    valid_after = 0
    valid_before = int(time.time()) + 300  # 5-minute validity window
    nonce_bytes = sec_module.token_bytes(32)

    signed = account.sign_typed_data(
        domain_data={
            "name": "USD Coin",
            "version": "2",
            "chainId": BASE_CHAIN_ID,
            "verifyingContract": asset,
        },
        message_types={
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"},
                {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ],
        },
        message_data={
            "from": account.address,
            "to": pay_to,
            "value": amount_units,
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": nonce_bytes,
        },
    )

    return {
        "signature": "0x" + signed.signature.hex(),
        "authorization": {
            "from": account.address,
            "to": pay_to,
            "value": str(amount_units),
            "validAfter": str(valid_after),
            "validBefore": str(valid_before),
            "nonce": "0x" + nonce_bytes.hex(),
        },
    }


def build_x402_payment_header(requirements: dict, account) -> str | None:
    """Build the base64-encoded X-Payment header from a 402 payment requirement.

    Returns None if payment is refused (amount too high, wrong network, etc.).
    """
    scheme = requirements.get("scheme", "")
    network = requirements.get("network", "")
    asset = requirements.get("asset", USDC_BASE_ADDRESS)
    pay_to = requirements.get("payTo", "")
    max_amount_str = requirements.get("maxAmountRequired", "0")

    # Validate scheme and network
    if scheme != "exact":
        log.warning("x402: unsupported scheme '%s' — only 'exact' supported.", scheme)
        return None

    if "base" not in network.lower():
        log.warning("x402: unsupported network '%s' — only Base supported.", network)
        return None

    if not pay_to:
        log.warning("x402: missing payTo address in requirements.")
        return None

    # Parse amount and enforce safety ceiling
    try:
        amount_units = int(max_amount_str)
    except ValueError:
        log.warning("x402: invalid maxAmountRequired '%s'.", max_amount_str)
        return None

    amount_usd = amount_units / (10 ** USDC_DECIMALS)
    if amount_usd > MAX_PAYMENT_PER_CALL_USDC:
        log.error(
            "x402: payment requirement $%.4f exceeds safety ceiling $%.2f — refusing.",
            amount_usd, MAX_PAYMENT_PER_CALL_USDC,
        )
        return None

    log.info("x402: signing payment of $%.4f USDC to %s", amount_usd, pay_to)

    try:
        payload = _sign_eip3009(account, pay_to, amount_units, asset)
    except Exception as exc:
        log.error("x402: EIP-3009 signing failed: %s", exc)
        return None

    payment = {
        "x402Version": 1,
        "scheme": "exact",
        "network": network,
        "payload": payload,
    }

    return base64.b64encode(json.dumps(payment).encode()).decode()


def _parse_payment_requirements(response: httpx.Response) -> dict | None:
    """Extract payment requirements from a 402 response.

    Tries the response body (JSON) first, then the X-Payment-Requirements header.
    Returns the first 'exact' + 'base' requirement found, or None.
    """
    # Try JSON body first (most common x402 implementation)
    try:
        body = response.json()
        accepts = body.get("accepts", [])
        for req in accepts:
            if req.get("scheme") == "exact" and "base" in req.get("network", "").lower():
                return req
        # Some implementations put requirements at the top level
        if body.get("scheme") == "exact":
            return body
    except Exception:
        pass

    # Fall back to X-Payment-Requirements header
    header = response.headers.get("X-Payment-Requirements") or response.headers.get("X-Payment-Requirement")
    if header:
        try:
            data = json.loads(base64.b64decode(header))
            if isinstance(data, list):
                for req in data:
                    if req.get("scheme") == "exact" and "base" in req.get("network", "").lower():
                        return req
            elif isinstance(data, dict):
                return data
        except Exception:
            pass

    log.warning("x402: could not parse payment requirements from 402 response. Body: %s",
                response.text[:500])
    return None


# ---------------------------------------------------------------------------
# ClawRouter HTTP client (x402-aware)
# ---------------------------------------------------------------------------


def clawrouter_request(
    endpoint: str,
    payload: dict,
    headers: dict | None = None,
) -> tuple[dict, float]:
    """POST to ClawRouter, automatically handling x402 payment challenges.

    Returns (response_json, usdc_spent).

    The first attempt is sent without payment. If the server returns 402,
    we sign the required payment and retry once. If the retry also returns
    a non-200 status, the error is raised.
    """
    account = get_evm_account()
    url = f"{CLAW_ROUTER_URL}/{endpoint.lstrip('/')}"
    req_headers = {"Content-Type": "application/json"}
    if CLAW_ROUTER_API_KEY:
        req_headers["Authorization"] = f"Bearer {CLAW_ROUTER_API_KEY}"
    if headers:
        req_headers.update(headers)

    usdc_spent = 0.0

    with httpx.Client(timeout=120.0) as client:
        # --- First attempt (no payment) ---
        response = client.post(url, json=payload, headers=req_headers)

        if response.status_code == 402:
            if account is None:
                raise RuntimeError(
                    "ClawRouter returned 402 but WDK_SEED_PHRASE is not set — "
                    "cannot sign x402 payment."
                )

            requirements = _parse_payment_requirements(response)
            if requirements is None:
                raise RuntimeError("ClawRouter returned 402 but could not parse payment requirements.")

            payment_header = build_x402_payment_header(requirements, account)
            if payment_header is None:
                raise RuntimeError("x402 payment refused — see logs for reason.")

            # Track cost before retry
            try:
                usdc_spent = int(requirements.get("maxAmountRequired", "0")) / (10 ** USDC_DECIMALS)
            except (ValueError, TypeError):
                usdc_spent = 0.0

            log.info("[x402] bridge paying $%.4f USDC directly for this call", usdc_spent)

            # --- Retry with payment ---
            retry_headers = dict(req_headers)
            retry_headers["X-Payment"] = payment_header
            response = client.post(url, json=payload, headers=retry_headers)

        if response.status_code not in (200, 201):
            raise RuntimeError(
                f"ClawRouter {response.status_code}: {response.text[:500]}"
            )

        return response.json(), usdc_spent


# ---------------------------------------------------------------------------
# Bootstrap file loader
# ---------------------------------------------------------------------------


def _read_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        log.warning("Bootstrap file not found: %s", path)
        return ""


def build_system_prompt(agent_name: str) -> str:
    """Assemble the system prompt from AGENTS.md, SOUL.md, and MEMORY.md."""
    sections: list[str] = []

    agents_md = _read_file(AGENT_PATH / "AGENTS.md")
    if agents_md:
        sections.append(agents_md)

    soul_md = _read_file(AGENT_PATH / "SOUL.md")
    if soul_md:
        sections.append("---\n\n" + soul_md)

    # Read MEMORY.md from the persistent volume path; fall back to the baked-in
    # template in the image if the volume file hasn't been created yet.
    memory_md = _read_file(MEMORY_PATH) or _read_file(AGENT_PATH / "MEMORY.md")
    if memory_md:
        sections.append("---\n\n# PERSISTENT MEMORY\n\n" + memory_md)

    if agent_name == "decision":
        sections.append(
            "---\n\n# Response Format\n\n"
            "You MUST respond with a valid JSON object only. "
            "No text, preamble, or markdown outside the JSON."
        )

    return "\n\n".join(filter(None, sections))


# ---------------------------------------------------------------------------
# Tool definitions (OpenAI function-calling format)
# ---------------------------------------------------------------------------

RELAY_OPS_TOOLS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "get_metrics",
            "description": (
                "Return rolling financial and operational metrics for the last N days. "
                "Call this at the start of every board meeting and before pricing or capital decisions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "days": {
                        "type": "integer",
                        "description": "Rolling window in days. Common values: 1, 7, 30.",
                    }
                },
                "required": ["days"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_runway",
            "description": (
                "Calculate operational runway: how many days can the relay operate at current cost rates? "
                "Returns totalLiquidUsd, aavePositionUsd, trxReserveTrx, dailyRevenue, dailyExpenses, "
                "netDailyCost, isProfit, aaveApy."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_experiments",
            "description": (
                "Return the experiment log, optionally filtered by status. "
                "Call at the start of every board meeting to review pending experiments."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["pending", "evaluated"],
                        "description": "Filter by status. Omit to return all.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number to return (default: 20, most recent first).",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_experiment",
            "description": (
                "Create a new experiment record. "
                "ALWAYS call this BEFORE taking the action described in 'decision'. "
                "Required before fee changes, Aave rebalancing >10%, or new operational approaches."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "context": {
                        "type": "string",
                        "description": "What situation prompted this experiment.",
                    },
                    "hypothesis": {
                        "type": "string",
                        "description": "Specific, measurable prediction.",
                    },
                    "decision": {
                        "type": "string",
                        "description": "What action will be taken.",
                    },
                    "metric": {
                        "type": "string",
                        "description": "What to measure to evaluate the outcome.",
                    },
                    "checkDate": {
                        "type": "string",
                        "description": "ISO date (YYYY-MM-DD) when to evaluate. Must be in the future.",
                    },
                },
                "required": ["context", "hypothesis", "decision", "metric", "checkDate"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "evaluate_experiment",
            "description": (
                "Record the outcome and learning from a completed experiment. "
                "Call when get_experiments returns experiments with check_date in the past."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "The experiment UUID from get_experiments.",
                    },
                    "outcome": {
                        "type": "string",
                        "description": "What actually happened (be specific and measurable).",
                    },
                    "learning": {
                        "type": "string",
                        "description": "What this implies for future decisions.",
                    },
                },
                "required": ["id", "outcome", "learning"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_fee",
            "description": (
                "Change the relay fee percentage. Takes effect immediately for new payments. "
                "Constraints: fee 0.1%–2.0%, max single-step change 0.5% (use 0.2% without evidence). "
                "MUST call save_experiment first."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "newPercent": {
                        "type": "number",
                        "description": "New fee as a percentage (e.g., 0.25 for 0.25%).",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Human-readable reason, including experiment ID if applicable.",
                    },
                },
                "required": ["newPercent", "reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_capital_summary",
            "description": (
                "Return a snapshot of all capital positions: liquid USDT on Arbitrum, "
                "liquid USDC on Base (note: this USDC also funds inference payments via x402), "
                "Aave USDT deposit, TRX reserve, Aave APY, total USD equivalent."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "deposit_to_aave",
            "description": (
                "Deposit USDT from the liquid balance into Aave lending pool on Arbitrum. "
                "Call save_experiment first if deposit is >10% of current Aave position."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "amountUsdt": {
                        "type": "string",
                        "description": "Decimal string amount, e.g. '50.00'. Minimum: 1 USDT.",
                    }
                },
                "required": ["amountUsdt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "withdraw_from_aave",
            "description": (
                "Withdraw USDT from Aave back to liquid balance. "
                "Only for operational reasons (float replenishment). Never for speculative purposes. "
                "Use 'MAX' to withdraw the full position."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "amountUsdt": {
                        "type": "string",
                        "description": "Decimal string amount, or 'MAX' for full withdrawal.",
                    }
                },
                "required": ["amountUsdt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "swap_tron_usdt_for_trx",
            "description": (
                "Swap USDT for native TRX on Tron via SunSwap v2 to top up the energy sponsorship reserve. "
                "Use when checkTrxReserveLow fires or trx_reserve_low anomaly is detected. "
                "Small swaps only (1–20 USDT) — this is a maintenance operation, not speculation."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "amountUsdt": {
                        "type": "string",
                        "description": "Decimal string amount of USDT to swap, e.g. '5.00'.",
                    }
                },
                "required": ["amountUsdt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "swap_usdt_to_eth_arb",
            "description": (
                "Swap USDT for native ETH on Arbitrum via Uniswap v3 to top up the gas buffer. "
                "Use when arb_eth_low anomaly fires. "
                "Small swaps only (1–10 USDT) — just enough to cover ~20–100 Aave transactions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "amountUsdt": {
                        "type": "string",
                        "description": "Decimal string amount of USDT to swap, e.g. '2.00'.",
                    }
                },
                "required": ["amountUsdt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_eth_balance_arb",
            "description": (
                "Return the agent's native ETH balance on Arbitrum. "
                "Use to check the gas buffer before or after swapping."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bridge_tron_to_arbitrum",
            "description": (
                "Bridge USDT from Tron to Arbitrum via deBridge DLN. "
                "Use when the Tron USDT balance significantly exceeds the minimum float "
                "and the Aave position needs replenishment. "
                "Returns a deBridge orderId — call get_bridge_order_status to track completion. "
                "Only bridge amounts above the minimum float (AAVE_MIN_FLOAT_DAYS × avg daily volume)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "amountUsdt": {
                        "type": "string",
                        "description": "Decimal string amount of Tron USDT to bridge, e.g. '100.00'.",
                    }
                },
                "required": ["amountUsdt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_bridge_order_status",
            "description": (
                "Poll the status of a deBridge DLN bridge order. "
                "Call after bridge_tron_to_arbitrum to track completion. "
                "Status values: created, fulfilled, sentUnlock, orderCancelled, unknown."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "orderId": {
                        "type": "string",
                        "description": "The deBridge order ID returned by bridge_tron_to_arbitrum.",
                    }
                },
                "required": ["orderId"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_akt_balance",
            "description": (
                "Return the agent's AKT wallet balance on the Akash Network. "
                "Use to check how much AKT is available before topping up escrow."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_akash_escrow_status",
            "description": (
                "Return the escrow balance, drain rate, and estimated runway for a running "
                "Akash deployment. Call when akash_escrow_low anomaly fires or during board "
                "meetings to check hosting status. "
                "Returns: balanceAkt, drainRateUaktPerBlock, monthlyBurnAkt, estimatedMonthsRemaining."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dseq": {
                        "type": "string",
                        "description": "Deployment sequence number (AKASH_DEPLOYMENT_DSEQ).",
                    }
                },
                "required": ["dseq"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "topup_akash_escrow",
            "description": (
                "Deposit AKT into a deployment's escrow to extend its runway. "
                "Use when akash_escrow_low fires or when estimatedMonthsRemaining < 1.5. "
                "Target: restore 3 months of runway (3 × monthlyBurnAkt). "
                "Never top up more than 90% of current AKT wallet balance. "
                "Minimum useful top-up: 2 AKT."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dseq": {
                        "type": "string",
                        "description": "Deployment sequence number (AKASH_DEPLOYMENT_DSEQ).",
                    },
                    "amountAkt": {
                        "type": "string",
                        "description": "Decimal string amount of AKT to deposit, e.g. '10.00'.",
                    },
                },
                "required": ["dseq", "amountAkt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_memory",
            "description": (
                "Append a note to MEMORY.md so it persists across agent sessions. "
                "Use this to record board meeting summaries, key decisions, experiment learnings, "
                "and any priors that should inform future runs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": (
                            "Content to append. Include a date header, e.g.: "
                            "'## Board Meeting 2026-03-13\\n\\n- Revenue healthy...'"
                        ),
                    }
                },
                "required": ["content"],
            },
        },
    },
]

# ---------------------------------------------------------------------------
# Tool execution — calls TypeScript internal API or performs local file ops
# ---------------------------------------------------------------------------


def execute_tool(tool_name: str, tool_input: dict) -> Any:
    base = RELAY_INTERNAL_URL

    try:
        if tool_name == "get_metrics":
            r = requests.get(f"{base}/metrics", params={"days": tool_input["days"]}, timeout=10)

        elif tool_name == "get_runway":
            r = requests.get(f"{base}/runway", timeout=10)

        elif tool_name == "get_experiments":
            params: dict = {}
            if "status" in tool_input:
                params["status"] = tool_input["status"]
            if "limit" in tool_input:
                params["limit"] = tool_input["limit"]
            r = requests.get(f"{base}/experiments", params=params, timeout=10)

        elif tool_name == "save_experiment":
            r = requests.post(f"{base}/experiments", json=tool_input, timeout=10)

        elif tool_name == "evaluate_experiment":
            exp_id = tool_input["id"]
            r = requests.patch(
                f"{base}/experiments/{exp_id}/evaluate",
                json={"outcome": tool_input["outcome"], "learning": tool_input["learning"]},
                timeout=10,
            )

        elif tool_name == "update_fee":
            r = requests.post(f"{base}/fee", json=tool_input, timeout=10)

        elif tool_name == "get_capital_summary":
            r = requests.get(f"{base}/capital", timeout=10)

        elif tool_name == "deposit_to_aave":
            r = requests.post(f"{base}/aave/deposit", json=tool_input, timeout=30)

        elif tool_name == "withdraw_from_aave":
            r = requests.post(f"{base}/aave/withdraw", json=tool_input, timeout=30)

        elif tool_name == "swap_tron_usdt_for_trx":
            r = requests.post(f"{base}/tron/swap-trx", json=tool_input, timeout=60)

        elif tool_name == "swap_usdt_to_eth_arb":
            r = requests.post(f"{base}/arb/swap-eth", json=tool_input, timeout=60)

        elif tool_name == "get_eth_balance_arb":
            r = requests.get(f"{base}/eth-balance", timeout=10)

        elif tool_name == "bridge_tron_to_arbitrum":
            r = requests.post(f"{base}/bridge/tron-to-arb", json=tool_input, timeout=30)

        elif tool_name == "get_bridge_order_status":
            order_id = tool_input["orderId"]
            r = requests.get(f"{base}/bridge/status/{order_id}", timeout=10)

        elif tool_name == "get_akt_balance":
            r = requests.get(f"{base}/akash/balance", timeout=10)

        elif tool_name == "get_akash_escrow_status":
            dseq = tool_input["dseq"]
            r = requests.get(f"{base}/akash/escrow/{dseq}", timeout=30)

        elif tool_name == "topup_akash_escrow":
            r = requests.post(f"{base}/akash/escrow/topup", json=tool_input, timeout=60)

        elif tool_name == "update_memory":
            return _append_memory(tool_input["content"])

        else:
            return {"error": f"Unknown tool: {tool_name}"}

        r.raise_for_status()
        return r.json()

    except requests.RequestException as exc:
        log.error("Tool %s HTTP call failed: %s", tool_name, exc)
        return {"error": str(exc)}


def _append_memory(content: str) -> dict:
    try:
        # Ensure the parent directory exists (e.g. /app/data/).
        MEMORY_PATH.parent.mkdir(parents=True, exist_ok=True)

        if MEMORY_PATH.exists():
            existing = MEMORY_PATH.read_text(encoding="utf-8")
        else:
            # First write: seed from the baked-in template so the agent sees
            # the structured sections rather than a blank file.
            template = AGENT_PATH / "MEMORY.md"
            existing = template.read_text(encoding="utf-8") if template.exists() else ""

        separator = "\n\n---\n\n" if existing.strip() else ""
        MEMORY_PATH.write_text(existing + separator + content.strip() + "\n", encoding="utf-8")
        log.info("MEMORY.md updated at %s (%d chars appended)", MEMORY_PATH, len(content))
        return {"ok": True, "appended": len(content)}
    except OSError as exc:
        log.error("Failed to update MEMORY.md: %s", exc)
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# USDC balance snapshot (for exact session cost measurement)
# ---------------------------------------------------------------------------

_BASE_RPC = os.environ.get("BASE_RPC_URL", "https://mainnet.base.org")


def _get_usdc_balance(address: str) -> float:
    """Return the USDC balance on Base for a given address.

    Uses a raw eth_call (ERC-20 balanceOf) over JSON-RPC so we don't need
    the web3 package. Returns 0.0 on any error (non-blocking).
    """
    # balanceOf(address) selector = keccak256("balanceOf(address)")[:4] = 0x70a08231
    padded = address[2:].lower().zfill(64)
    payload = {
        "jsonrpc": "2.0",
        "method": "eth_call",
        "params": [{"to": USDC_BASE_ADDRESS, "data": f"0x70a08231{padded}"}, "latest"],
        "id": 1,
    }
    try:
        with httpx.Client(timeout=8.0) as client:
            r = client.post(_BASE_RPC, json=payload)
            raw = r.json().get("result", "0x0") or "0x0"
            return int(raw, 16) / (10 ** USDC_DECIMALS)
    except Exception as exc:
        log.debug("USDC balance query failed: %s", exc)
        return 0.0


# ---------------------------------------------------------------------------
# Agent session runner
# ---------------------------------------------------------------------------


def run_agent_session(
    message: str,
    agent_name: str,
    session_id: str,
    thinking_level: str | None,
    context: dict | None,
) -> dict:
    """Run a complete agent session via ClawRouter with relay-ops tool use.

    Uses the OpenAI chat completions format (ClawRouter is OpenAI-compatible).
    Each inference call triggers an x402 USDC micropayment on Base.

    The agentic loop:
      1. Send user message + system prompt to ClawRouter
      2. If response contains tool_calls, execute each tool
      3. Append assistant message + tool results to history
      4. Repeat until finish_reason == 'stop' or max iterations reached
    """
    start_ms = int(time.time() * 1000)
    run_id = f"run-{session_id}-{uuid.uuid4().hex[:8]}"

    model = AGENT_MODELS.get(agent_name, CLAW_ROUTER_MODEL)
    system_prompt = build_system_prompt(agent_name)

    user_content = message
    if context:
        user_content += f"\n\nContext:\n{json.dumps(context, indent=2)}"

    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]

    total_input_tokens = 0
    total_output_tokens = 0
    total_usdc_spent = 0.0
    all_tool_calls: list[dict] = []
    final_text = ""

    # Extended thinking: map level to Anthropic budget_tokens.
    # When enabled, thinking tokens count toward max_tokens, so we raise the ceiling.
    _THINKING_BUDGET = {"low": 2_000, "adaptive": 5_000, "high": 10_000}
    thinking_budget = _THINKING_BUDGET.get(thinking_level or "", 0) if thinking_level else 0
    max_output_tokens = (thinking_budget + 8_000) if thinking_budget else 16_000

    log.info(
        "session=%s agent=%s model=%s thinking=%s",
        session_id, agent_name, model,
        f"{thinking_level} ({thinking_budget} tokens)" if thinking_budget else "off",
    )

    max_iterations = 20
    for iteration in range(max_iterations):
        payload = {
            "model": model,
            "messages": messages,
            "tools": RELAY_OPS_TOOLS,
            "max_tokens": max_output_tokens,
        }
        if thinking_budget:
            payload["thinking"] = {"type": "enabled", "budget_tokens": thinking_budget}

        try:
            data, usdc_spent = clawrouter_request("chat/completions", payload)
        except RuntimeError as exc:
            log.error("session=%s inference failed: %s", session_id, exc)
            break

        total_usdc_spent += usdc_spent

        # Parse usage
        usage = data.get("usage", {})
        call_input = usage.get("prompt_tokens", 0)
        call_output = usage.get("completion_tokens", 0)
        total_input_tokens += call_input
        total_output_tokens += call_output

        # Token-based cost estimate (input: $3/M, output: $15/M for Sonnet).
        call_cost = call_input * 0.000003 + call_output * 0.000015
        total_usdc_spent += call_cost
        log.info(
            "session=%s iter=%d tokens=%d+%d cost=~$%.4f",
            session_id, iteration + 1, call_input, call_output, call_cost,
        )

        choice = data.get("choices", [{}])[0]
        finish_reason = choice.get("finish_reason", "stop")
        assistant_message = choice.get("message", {})
        raw_content = assistant_message.get("content") or ""
        tool_calls = assistant_message.get("tool_calls") or []

        # Content may be a list of typed blocks when thinking is enabled
        # (e.g. [{"type": "thinking", "thinking": "..."}, {"type": "text", "text": "..."}])
        # or a plain string for normal responses.
        thinking_text = ""
        if isinstance(raw_content, list):
            text_parts = []
            for block in raw_content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type", "")
                if btype == "thinking":
                    thinking_text = block.get("thinking") or block.get("text") or ""
                elif btype == "text":
                    text_parts.append(block.get("text", ""))
            content = "\n".join(text_parts)
        else:
            content = raw_content

        if thinking_text:
            # Log the model's reasoning. Truncate to keep logs readable.
            preview = thinking_text[:1200] + ("..." if len(thinking_text) > 1200 else "")
            log.info("session=%s iter=%d [thinking]\n%s", session_id, iteration + 1, preview)

        if content:
            final_text = content

        if finish_reason == "stop" or not tool_calls:
            log.info("session=%s done after %d iteration(s)", session_id, iteration + 1)
            break

        if finish_reason == "tool_calls" or tool_calls:
            # Append assistant turn to history. Use raw_content (which includes
            # thinking blocks if present) so the model sees its own reasoning
            # in subsequent iterations.
            messages.append({
                "role": "assistant",
                "content": raw_content,
                "tool_calls": tool_calls,
            })

            # Execute each tool and collect results
            tool_results: list[dict] = []
            for tc in tool_calls:
                tool_name = tc["function"]["name"]
                try:
                    tool_input = json.loads(tc["function"]["arguments"])
                except (json.JSONDecodeError, KeyError):
                    tool_input = {}
                tool_call_id = tc["id"]

                log.info(
                    "session=%s tool=%s input=%s",
                    session_id, tool_name, json.dumps(tool_input)[:200],
                )

                result = execute_tool(tool_name, tool_input)

                all_tool_calls.append({
                    "tool": tool_name,
                    "input": tool_input,
                    "output": result,
                })

                tool_results.append({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": json.dumps(result),
                })

            messages.extend(tool_results)

        else:
            log.warning(
                "session=%s unexpected finish_reason=%s", session_id, finish_reason
            )
            break

    else:
        log.warning("session=%s hit max iterations (%d)", session_id, max_iterations)

    duration_ms = int(time.time() * 1000) - start_ms

    log.info(
        "session=%s cost=~$%.6f tokens=%d+%d duration=%dms",
        session_id, total_usdc_spent, total_input_tokens, total_output_tokens, duration_ms,
    )

    return {
        "runId": run_id,
        "text": final_text,
        "toolCalls": all_tool_calls,
        "estimatedCostUsd": total_usdc_spent,
        "totalTokens": total_input_tokens + total_output_tokens,
        "durationMs": duration_ms,
    }


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------

app = Flask(__name__)


@app.route("/agent/run", methods=["POST"])
def agent_run():
    """Run an agent session. Blocks until the session completes."""
    body = request.get_json(force=True, silent=True) or {}

    message: str = body.get("message", "")
    agent_name: str = body.get("agent", "main")
    session_id: str = body.get("sessionId", f"session-{uuid.uuid4().hex[:8]}")
    thinking: str | None = body.get("thinking")
    context: dict | None = body.get("context")

    if not message:
        return jsonify({"error": "message is required"}), 400

    try:
        result = run_agent_session(message, agent_name, session_id, thinking, context)
        return jsonify(result)
    except Exception as exc:
        log.exception("Agent session %s failed: %s", session_id, exc)
        return jsonify({
            "runId": "error",
            "text": "",
            "toolCalls": [],
            "estimatedCostUsd": 0.0,
            "totalTokens": 0,
            "durationMs": 0,
            "error": str(exc),
        }), 500


@app.route("/health", methods=["GET"])
def health():
    account = get_evm_account()
    return jsonify({
        "status": "ok",
        "inferenceBackend": "clawrouter",
        "clawRouterUrl": CLAW_ROUTER_URL,
        "x402WalletAddress": account.address if account else None,
        "agentPath": str(AGENT_PATH),
        "relayInternalUrl": RELAY_INTERNAL_URL,
    })


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if not CLAW_ROUTER_URL:
        log.error("CLAW_ROUTER_URL is not set. Exiting.")
        sys.exit(1)

    if "api.clawrouter.ai" in CLAW_ROUTER_URL:
        log.warning(
            "CLAW_ROUTER_URL points to the hosted endpoint (%s). "
            "This requires account registration and will return 401. "
            "Run ClawRouter locally and set CLAW_ROUTER_URL=http://host.docker.internal:8402/v1",
            CLAW_ROUTER_URL,
        )

    account = get_evm_account()
    if account is None:
        log.warning(
            "WDK_SEED_PHRASE not set — x402 payments will fail at runtime. "
            "Set WDK_SEED_PHRASE to enable autonomous inference funding."
        )

    log.info("Starting openclaw-bridge on port %d", BRIDGE_PORT)
    log.info("Inference backend: ClawRouter at %s", CLAW_ROUTER_URL)
    log.info("Models: standard=%s, board-meeting=%s", CLAW_ROUTER_MODEL, CLAW_ROUTER_MODEL_BOARD)
    log.info("Agent path: %s", AGENT_PATH)
    log.info("Relay internal URL: %s", RELAY_INTERNAL_URL)
    if account:
        log.info("x402 wallet: %s (Base USDC funds inference)", account.address)

    app.run(host="127.0.0.1", port=BRIDGE_PORT, debug=False)
