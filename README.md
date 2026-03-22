# Charon

Charon is an autonomous USDT payment relay that runs its own business. It accepts USDT on TRON on behalf of developers, deducts a fee, and forwards the net amount to their wallet. It then manages its own capital — earning yield on idle funds via Aave, maintaining a TRX reserve for gas sponsorship, and paying for its own AI inference via x402 micropayments on Base.

A board meeting agent runs daily, reviews financial performance, and adjusts the relay fee and capital allocation based on evidence. The agent pays for its own reasoning using the fees it earns.

---

## What it does

1. **Payment relay** — A developer registers and gets an API key. When their customer needs to pay, the developer calls `/payment/create` to get a TRON deposit address. Charon watches that address, collects the USDT, deducts a fee (~0.3%), and forwards the rest to the developer's wallet. Energy costs for the TRON transaction are sponsored from the relay's TRX reserve — the sender pays zero gas.

2. **Yield generation** — Idle USDT is bridged to Arbitrum and deposited into Aave v3 to earn lending yield.

3. **Autonomous management** — An AI agent (Claude) runs a daily board meeting. It reads financial metrics, evaluates past experiments, and makes decisions: adjust the relay fee, rebalance the Aave position, top up the TRX reserve, replenish the Akash hosting escrow. All decisions are logged to `agent/MEMORY.md` and persist across sessions.

4. **Self-funding inference** — The agent pays for its own reasoning via x402 micropayments (USDC on Base). The `/payment/create` API endpoint is itself gated by a $0.01 x402 fee, which flows into the Base wallet that funds inference.

---

## Architecture

Three processes run in a single Docker container managed by `supervisord`:

| Process | Port | Role |
|---------|------|------|
| **Relay** (Node.js) | 3000 (public) | HTTP API, payment monitor, wallet ops, SQLite |
| **ClawRouter** (Node.js) | 8402 (internal) | x402-native OpenAI-compatible inference router |
| **OpenClaw Bridge** (Python) | 4001 (internal) | Runs agent sessions, executes tool decisions |

All inter-process communication uses localhost. The relay exposes port 3000 externally; the other two are internal only.

### Payment flow

```
Developer calls POST /payment/create
  → relay assigns a TRON deposit address (HD wallet, index 3+)
  → monitor polls TRON every 3s for incoming USDT
  → on detection: sponsor TRX energy → forward USDT → fire webhook → record metrics
```

### Agent decision loop

```
Daily cron (00:00 UTC)
  → relay calls POST bridge:4001/agent/run
  → bridge reads AGENTS.md + SOUL.md + MEMORY.md
  → requests inference from ClawRouter (pays via x402 in USDC on Base)
  → agent calls /internal/* tools to read state and execute decisions
  → bridge appends session summary to MEMORY.md
```

---

## Wallet structure

All wallets are derived from a single BIP-39 seed phrase (`WDK_SEED_PHRASE`):

| Index | Chain | Derivation path | Role |
|-------|-------|-----------------|------|
| 0 | TRON | m/44'/195'/0'/0/0 | Agent hot wallet (TRX reserve, energy sponsorship) |
| 1–2 | TRON | m/44'/195'/0'/0/1–2 | Reserved |
| 3+ | TRON | m/44'/195'/0'/0/3+ | Customer deposit addresses (address pool) |
| 0 | EVM | m/44'/60'/0'/0/0 | Arbitrum USDT, Aave, Base USDC (inference funding) |

---

## Running locally

**Requirements:** Node.js 22, Python 3.11+, Docker (for production)

```bash
# Install dependencies
npm install
pip install -r openclaw-bridge/requirements.txt

# Configure
cp .env.testnet .env   # or .env.mainnet for production
# Edit .env — set WDK_SEED_PHRASE, TRON_API_KEY, CDP_API_KEY_*, etc.

# Development (TypeScript, hot reload)
npm run dev

# Production build
npm run build
npm start
```

The relay starts on port 3000. The OpenClaw bridge and ClawRouter only start when run via Docker (supervisord).

---

## Docker

```bash
# Build
docker build -t charon .

# Run (testnet)
docker run --env-file .env.testnet -p 3000:3000 charon

# Run (mainnet)
docker run --env-file .env.mainnet -p 3000:3000 charon
```

Mount a persistent volume at `/app/data` to preserve the SQLite database and agent memory across restarts:

```bash
docker run --env-file .env.mainnet -p 3000:3000 \
  -v charon-data:/app/data charon
```

---

## Deploying to Akash

See `akash/deploy.yaml`. Akash runs the Docker container on decentralised cloud compute, paid in AKT. The agent monitors its own Akash escrow and tops it up autonomously when needed.

```bash
# Deploy
akash tx deployment create akash/deploy.yaml \
  --from <your-key> --chain-id akashnet-2

# After deployment, set AKASH_DEPLOYMENT_DSEQ in .env to the returned dseq value.
# The agent uses this to monitor and top up the escrow.
```

---

## API

All endpoints are on port 3000.

### Developer endpoints

```
POST /developer/register     Register and receive an API key
GET  /developer/me           Verify your API key
```

**Register:**
```json
POST /developer/register
{
  "receivingAddress": "TYour...TronAddress",
  "webhookUrl": "https://yourapp.com/webhook",
  "webhookSecret": "your-32-char-secret",
  "payoutChain": "tron"
}
```

### Payment endpoints

```
POST /payment/create         Create a payment session (gated by x402 $0.01 if CDP keys set)
GET  /payment/:id/status     Poll payment status
```

**Create payment:**
```json
POST /payment/create
X-Api-Key: <your-api-key>

{
  "amount": "10.00",
  "currency": "USDT",
  "orderId": "order-123",
  "expiresInMinutes": 30
}
```

Response includes a TRON deposit address and the exact `amountDue` (includes relay fee and energy sponsorship). When payment is received and forwarded, your webhook receives a signed payload.

### Admin endpoints (requires `X-Admin-Key` header)

```
GET  /admin/status           Full health snapshot: balances, Aave position, metrics
GET  /admin/logs             Recent activity log (filterable by category, level, time)
POST /admin/board-meeting    Trigger a board meeting immediately
POST /admin/anomaly-check    Run all anomaly checks now
POST /admin/trigger-tool     Call any agent tool directly
POST /admin/trigger-anomaly/:type   Simulate an anomaly and run its handler
```

---

## Demo

Run the end-to-end demo script to walk through the full developer flow:

```bash
pip install requests eth-account python-dotenv

# Against local relay
python3 demo_relay_flow.py

# Against Akash deployment
SERVER_URL=https://your-akash-url.com \
PAYOUT_ADDRESS=TYour...TronAddress \
python3 demo_relay_flow.py
```

The script registers a developer account, creates a payment session, waits for USDT to arrive, and confirms forwarding — narrating each step.

---

## Configuration

Key environment variables (see `.env.testnet` for full annotated list):

| Variable | Description |
|----------|-------------|
| `WDK_SEED_PHRASE` | BIP-39 seed phrase — all wallets derived from this |
| `TRON_RPC_URL` | TronGrid endpoint (`https://api.trongrid.io` for mainnet) |
| `TRON_API_KEY` | TronGrid API key |
| `TRON_USDT_CONTRACT` | USDT TRC-20 contract (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` on mainnet) |
| `ARBITRUM_RPC_URL` | Arbitrum RPC endpoint |
| `BASE_RPC_URL` | Base RPC endpoint |
| `CDP_API_KEY_NAME` / `CDP_API_KEY_PRIVATE_KEY` | Coinbase CDP keys for x402 payment verification |
| `ADMIN_API_KEY` | Protects `/admin/*` routes |
| `RELAY_FEE_PERCENT` | Starting relay fee (agent adjusts dynamically) |
| `AAVE_MIN_FLOAT_DAYS` | Days of average volume to keep liquid (not deposited to Aave) |

---

## Funding requirements

To run on mainnet, fund these wallets (all derived from `WDK_SEED_PHRASE`):

| Wallet | Minimum | Purpose |
|--------|---------|---------|
| TRON index 0 | 100+ TRX | Energy sponsorship for customer payments |
| EVM index 0 (Base) | $5+ USDC | AI inference payments via x402 |
| EVM index 0 (Arbitrum) | 0.005+ ETH | Gas for Aave deposit/withdraw transactions |

The relay earns its operating costs from fees. The above is seed capital to get started. On testnet, use the faucets listed in `.env.testnet`.
