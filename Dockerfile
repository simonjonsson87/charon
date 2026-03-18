# ─── Build stage: compile TypeScript ─────────────────────────────────────────
FROM node:22-slim AS builder

# Build tools needed to compile better-sqlite3 (native addon)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY node_modules/ ./node_modules/
RUN npm rebuild

COPY tsconfig.json .
COPY src/ ./src/
RUN npm run build

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Install Python 3 + pip + supervisor to run three processes in one container.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      supervisor \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node.js relay
COPY --from=builder /app/dist/       ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY package.json ./

# ClawRouter — x402-native LLM router (no API key required, pays via USDC on Base).
# Installs globally so the binary is at /usr/local/lib/node_modules/@blockrun/clawrouter/
RUN npm install -g @blockrun/clawrouter

# Startup wrapper: derives BLOCKRUN_WALLET_KEY from WDK_SEED_PHRASE at launch.
COPY clawrouter-start.js ./

# Python OpenClaw bridge
COPY openclaw-bridge/ ./openclaw-bridge/
RUN pip3 install --no-cache-dir --break-system-packages -r openclaw-bridge/requirements.txt

# Agent bootstrap files (AGENTS.md, SOUL.md, MEMORY.md)
COPY agent/ ./agent/

# supervisord configuration
COPY supervisord.conf /etc/supervisor/conf.d/relay.conf

# SQLite data directory — mount a persistent volume here in production.
RUN mkdir -p /app/data

# Port 3000 is the public-facing relay API.
# Port 8402 is ClawRouter (localhost-only).
# Port 4001 is the OpenClaw bridge (localhost-only).
EXPOSE 3000

CMD ["supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
