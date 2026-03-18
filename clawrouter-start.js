#!/usr/bin/env node
/**
 * clawrouter-start.js — Startup wrapper for ClawRouter.
 *
 * Derives BLOCKRUN_WALLET_KEY from WDK_SEED_PHRASE (same derivation path as
 * the TypeScript relay: m/44'/60'/0'/0/0) so that a single seed phrase funds
 * both Tron/EVM relay operations and ClawRouter x402 inference payments.
 *
 * If BLOCKRUN_WALLET_KEY is already set explicitly in the environment, it is
 * used as-is (override path for advanced users).
 */

const { spawn } = require('child_process');
const path = require('path');

async function main() {
  if (process.env.WDK_SEED_PHRASE && !process.env.BLOCKRUN_WALLET_KEY) {
    try {
      const { ethers } = require(path.join(__dirname, 'node_modules/ethers'));
      const wallet = ethers.HDNodeWallet.fromPhrase(
        process.env.WDK_SEED_PHRASE,
        undefined,
        "m/44'/60'/0'/0/0",
      );
      process.env.BLOCKRUN_WALLET_KEY = wallet.privateKey;
      console.log('[clawrouter-start] Derived BLOCKRUN_WALLET_KEY from WDK_SEED_PHRASE');
      console.log('[clawrouter-start] ClawRouter wallet (Base):', wallet.address);
    } catch (e) {
      console.error('[clawrouter-start] Failed to derive wallet key:', e.message);
      console.error('[clawrouter-start] Set BLOCKRUN_WALLET_KEY explicitly to bypass derivation.');
    }
  } else if (process.env.BLOCKRUN_WALLET_KEY) {
    console.log('[clawrouter-start] Using explicit BLOCKRUN_WALLET_KEY from environment.');
  } else {
    console.warn('[clawrouter-start] Neither WDK_SEED_PHRASE nor BLOCKRUN_WALLET_KEY is set.');
    console.warn('[clawrouter-start] ClawRouter will generate a temporary wallet — x402 payments will fail until funded.');
  }

  const clawrouterBin = '/usr/local/lib/node_modules/@blockrun/clawrouter/dist/cli.js';
  console.log('[clawrouter-start] Starting ClawRouter on port', process.env.BLOCKRUN_PROXY_PORT || '8402');

  const child = spawn('node', [clawrouterBin], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error('[clawrouter-start] Fatal:', e);
  process.exit(1);
});
