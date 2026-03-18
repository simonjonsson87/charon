/**
 * src/index.ts — Application entry point
 *
 * Boots the agent in a deterministic order:
 *   1. Environment variables
 *   2. Database (migrations + schema)
 *   3. WDK wallets (TRON, EVM)
 *   4. HTTP server (Fastify + x402 + routes)
 *   5. TRON payment monitor (polling loop)
 *   6. Intelligence data collectors (energy, network)
 *   7. Metrics collector
 *   8. Cron jobs (board meeting, anomaly checker, etc.)
 *   9. Startup summary log
 *
 * Graceful shutdown: SIGTERM and SIGINT both trigger an orderly teardown —
 * the monitor stops accepting new work, all in-flight DB writes complete,
 * and the HTTP server drains existing connections before the process exits.
 */

import dotenv from 'dotenv';
dotenv.config();

import { initDb } from './db/index';
import { initTronWallet, getTronWalletAddress } from './wallet/tron';
import { initEvmWallet, getWalletAddress } from './wallet/evm';
import { initAave } from './wallet/aave';
import { initTronGasfreeWallet } from './wallet/tronGasfree';
import { startServer, stopServer } from './server/index';
import { startMonitor, stopMonitor } from './relay/monitor';
import { refreshEnergyData } from './intelligence/energy';
import { startNetworkMonitor } from './intelligence/network';
import { startScheduler } from './monitoring/scheduler';
import { ensurePoolSize } from './db/queries/payments';
import { deriveAddress } from './wallet/tron';

const MIN_POOL_SIZE = 20;

async function main(): Promise<void> {
  console.log('[boot] Starting Charon...');

  // ---- 1. Database -------------------------------------------------------
  console.log('[boot] Initialising database...');
  initDb();
  console.log('[boot] Database ready.');

  // ---- 2. WDK Wallets ----------------------------------------------------
  console.log('[boot] Initialising wallets...');
  await initTronWallet();
  await initTronGasfreeWallet();
  await initEvmWallet();
  await initAave();

  const tronAddress = await getTronWalletAddress(0);
  const baseAddress = await getWalletAddress('base');
  const arbitrumAddress = await getWalletAddress('arbitrum');
  console.log(`[boot] TRON agent address : ${tronAddress}`);
  console.log(`[boot] Base agent address : ${baseAddress}`);
  console.log(`[boot] Arbitrum address   : ${arbitrumAddress}`);

  // ---- 3. Address pool ---------------------------------------------------
  // Seed the HD address pool on first run. deriveAddress is passed as a
  // callback so the pool manager doesn't need to import the wallet module.
  console.log(`[boot] Ensuring address pool has at least ${MIN_POOL_SIZE} addresses...`);
  await ensurePoolSize(MIN_POOL_SIZE, deriveAddress);
  console.log('[boot] Address pool ready.');

  // ---- 4. HTTP server ----------------------------------------------------
  const port = parseInt(process.env.PORT ?? '3000', 10);
  console.log(`[boot] Starting HTTP server on port ${port}...`);
  await startServer(port);
  console.log(`[boot] HTTP server listening on port ${port}.`);

  // ---- 5. Payment monitor ------------------------------------------------
  console.log('[boot] Starting TRON payment monitor...');
  startMonitor();
  console.log('[boot] Payment monitor running.');

  // ---- 6. Intelligence collectors ----------------------------------------
  // Seed an initial energy snapshot so the first API request is fast.
  console.log('[boot] Seeding initial energy data...');
  await refreshEnergyData();

  console.log('[boot] Starting network monitor...');
  startNetworkMonitor();

  // ---- 7. Cron scheduler -------------------------------------------------
  console.log('[boot] Registering cron jobs...');
  startScheduler();
  console.log('[boot] Scheduler running.');

  // ---- 8. Startup summary ------------------------------------------------
  console.log('');
  console.log('┌─────────────────────────────────────────────────┐');
  console.log('│              Charon — ONLINE                     │');
  console.log('├─────────────────────────────────────────────────┤');
  console.log(`│ TRON address  : ${tronAddress}  │`);
  console.log(`│ Base address  : ${baseAddress}  │`);
  console.log(`│ HTTP port     : ${port}                              │`);
  console.log(`│ DB path       : ${process.env.SQLITE_PATH ?? './data/agent.db'}   │`);
  console.log('└─────────────────────────────────────────────────┘');
  console.log('');
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
// Both SIGTERM (sent by process managers like pm2/Docker) and SIGINT (Ctrl-C)
// trigger the same teardown path. The order matters: stop accepting new
// requests first, then stop the monitor, then close the DB.
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[shutdown] Received ${signal}. Shutting down gracefully...`);
  try {
    await stopServer();
    stopMonitor();
    // The better-sqlite3 DB connection is synchronous and will be GC'd,
    // but explicit close is good practice.
    const { closeDb } = await import('./db/index');
    closeDb();
    console.log('[shutdown] Goodbye.');
    process.exit(0);
  } catch (err) {
    console.error('[shutdown] Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Unhandled rejections should not silently swallow errors at this layer.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled promise rejection:', reason);
  process.exit(1);
});

main().catch((err) => {
  console.error('[fatal] Startup failed:', err);
  process.exit(1);
});
