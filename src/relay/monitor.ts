/**
 * src/relay/monitor.ts — TRON payment monitor (core polling loop)
 *
 * This is the operational heart of the relay. It watches every active payment
 * address for incoming USDT TRC-20 transfers and drives each payment through
 * its state machine.
 *
 * State machine:
 *
 *   pending ──(USDT detected, amount >= amountDue)──► detected
 *   pending ──(expiresAt passed)────────────────────► expired    [cleanup job]
 *   detected ──(3 confirmations)────────────────────► confirmed
 *   confirmed ──(forward tx broadcast)─────────────► forwarded
 *   forwarded ──(webhook delivered)────────────────► [done]
 *   [any] ──(unrecoverable error)───────────────────► failed
 *
 * Polling approach vs WebSockets:
 *   TronGrid's free tier does not offer a persistent WebSocket subscription
 *   for TRC-20 events per address. Polling every TRON_POLL_INTERVAL_MS (3s)
 *   is the practical approach for MVP. At ~50 concurrent active payments, this
 *   generates ~50 API calls every 3 seconds — within TronGrid's free-tier limits.
 *
 *   For production scale (hundreds of concurrent payments), consider:
 *   - Running a TRON full/event node for direct event subscription.
 *   - Using TronGrid Pro for higher rate limits and WebSocket access.
 *   - Batching balance checks (check balances rather than event logs to reduce
 *     per-address API calls — one getAccount call returns the TRX/TRC-20 state).
 *
 * TronGrid rate limiting:
 *   If the monitor is polling too frequently for the available rate limit, the
 *   TRON_POLL_INTERVAL_MS env var should be increased. The monitor logs a
 *   warning when TronGrid returns 429 responses and backs off automatically.
 */

import axios from 'axios';
import { getActivePayments, updatePaymentStatus } from '../db/queries/payments';
import { recordConfirmation } from '../db/queries/confirmations';
import { getDeveloperById } from '../db/queries/developers';
import { getTransferEvents, getBalance } from '../wallet/tron';
import { forwardPayment } from '../wallet/tron';
import { bridgeTronToBase, getBridgeOrderStatus } from '../wallet/bridge';
import { releaseAddress } from './addressPool';
import { sponsorIfNeeded } from './gasless';
import { activateIfNeeded } from '../wallet/tronGasfree';
import { deliverWebhook } from './webhook';
import { recordTransaction } from '../monitoring/metrics';
import type { Payment } from '../db/schema';

const REQUIRED_CONFIRMATIONS = 3;
const POLL_INTERVAL_MS = parseInt(process.env.TRON_POLL_INTERVAL_MS ?? '3000', 10);

/** Tracks consecutive 429 responses to apply exponential backoff. */
let rateLimitBackoffUntil = 0;
let rateLimitConsecutive = 0;

/** Tracks the last-polled timestamp per address to avoid reprocessing events. */
const lastPolledAt: Map<string, number> = new Map();

let pollInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * startMonitor — Begin the payment polling loop.
 *
 * Loads all active payments from DB and starts a repeating interval.
 * Safe to call multiple times — subsequent calls are no-ops if already running.
 */
export function startMonitor(): void {
  if (isRunning) {
    console.warn('[monitor] Already running — startMonitor() called twice.');
    return;
  }

  isRunning = true;
  console.log(`[monitor] Starting poll loop every ${POLL_INTERVAL_MS}ms.`);

  pollInterval = setInterval(() => {
    pollPayments().catch((err) => {
      // Errors in the poll loop must not crash the process — log and continue.
      console.error('[monitor] Poll error:', err);
    });
  }, POLL_INTERVAL_MS);
}

/**
 * stopMonitor — Stop the polling loop.
 *
 * Called during graceful shutdown. In-flight polls complete; no new polls
 * are started after this call.
 */
export function stopMonitor(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  isRunning = false;
  console.log('[monitor] Stopped.');
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

/**
 * pollPayments — One iteration of the monitor loop.
 *
 * Fetches all active payments from the DB and checks each one.
 * Runs sequentially (not in parallel) to avoid hammering TronGrid with
 * simultaneous requests. At the expected scale, sequential polling within
 * a 3-second window is fine.
 *
 * On the first poll after startup, `lastPolledAt` is seeded from each
 * payment's `created_at` timestamp so we don't miss transfers that arrived
 * while the process was down. Without this, a restart after a long downtime
 * would only look back 60 seconds and could miss older inbound transfers.
 *
 * TODO: at higher scale, batch payments into groups and rate-limit the
 * TronGrid calls using a token-bucket approach.
 */
async function pollPayments(): Promise<void> {
  const activePayments = getActivePayments();

  for (const payment of activePayments) {
    try {
      // Seed lastPolledAt from created_at on first encounter after startup.
      // This ensures we scan from when the payment was created, not just the
      // last 60 seconds — critical for survivng restarts during active payments.
      if (!lastPolledAt.has(payment.address)) {
        lastPolledAt.set(payment.address, new Date(payment.created_at).getTime());
        const contract = process.env.TRON_USDT_CONTRACT ?? 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
        const rpc = process.env.TRON_RPC_URL ?? 'https://api.trongrid.io';
        console.log(
          `[monitor] Waiting for payment of ${payment.amount_due} USDT` +
          ` to ${payment.address}` +
          ` for token ${contract}` +
          ` using RPC ${rpc}` +
          ` — payment ${payment.id}`,
        );
        // Proactively activate the address so it can broadcast transactions when
        // it's time to forward. Unactivated addresses can't sign TXs. Firing now
        // (before the user sends USDT) means activation is done by the time funds
        // arrive. Fire-and-forget — don't block the first poll cycle.
        activateIfNeeded(payment.address).catch((err) =>
          console.error(`[monitor] Proactive activation failed for ${payment.address}:`, err),
        );
      }
      await checkPayment(payment);
    } catch (err) {
      console.error(`[monitor] Error checking payment ${payment.id}:`, err);
      // Do not mark as failed on transient errors — only on unrecoverable ones.
    }
  }
}

/**
 * checkPayment — Drive a single payment through its state machine.
 *
 * Dispatches to the appropriate handler based on current status.
 */
async function checkPayment(payment: Payment): Promise<void> {
  if (payment.status === 'pending') {
    await checkForIncomingTransfer(payment);
  } else if (payment.status === 'detected') {
    await checkConfirmations(payment);
  } else if (payment.status === 'bridging') {
    await checkBridgeStatus(payment);
  }
}

/**
 * checkForIncomingTransfer — Detect USDT arriving at a pending payment address.
 *
 * Uses balance polling rather than TronGrid event queries. TronGrid's
 * /transactions/trc20 endpoint returns nothing for unactivated addresses
 * (addresses that have only ever received TRC-20 tokens, never TRX). Balance
 * polling via /v1/accounts/{address} works regardless of activation status.
 *
 * Once a sufficient balance is detected, transitions to 'detected' and attempts
 * to look up the inbound tx hash from the event log (best-effort — forwarding
 * does not require the hash).
 */
async function checkForIncomingTransfer(payment: Payment): Promise<void> {
  if (Date.now() < rateLimitBackoffUntil) return;

  let balanceStr: string;
  try {
    balanceStr = await getBalance(payment.address);
    rateLimitConsecutive = 0;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 429) {
      rateLimitConsecutive++;
      const backoffMs = Math.min(60_000, 2_000 * 2 ** rateLimitConsecutive);
      rateLimitBackoffUntil = Date.now() + backoffMs;
      console.warn(`[monitor] TronGrid 429 — backing off ${backoffMs}ms (streak: ${rateLimitConsecutive}).`);
      return;
    }
    throw err;
  }

  const balance = parseFloat(balanceStr);
  const due     = parseFloat(payment.amount_due);

  if (balance < due) return; // Not yet paid.

  // Sufficient balance — payment received.
  // Try to retrieve the inbound tx hash from the event log (best-effort).
  let txHash = '';
  try {
    const sinceTs = lastPolledAt.get(payment.address) ?? new Date(payment.created_at).getTime();
    const events  = await getTransferEvents(payment.address, sinceTs);
    txHash = events[0]?.txHash ?? '';
  } catch {
    // Non-fatal — tx hash is for display only; forwarding doesn't need it.
  }
  lastPolledAt.set(payment.address, Date.now() - 60_000);

  console.log(`[monitor] Payment ${payment.id} detected. Balance: ${balance} USDT. TX: ${txHash || '(lookup pending)'}`);

  updatePaymentStatus(payment.id, 'detected', txHash || undefined, 0);
  await sponsorIfNeeded(payment.address, payment.id);
}

/**
 * checkConfirmations — Check if a detected payment has enough confirmations.
 *
 * Queries the current block height and compares to the block the transfer
 * was included in. Once REQUIRED_CONFIRMATIONS is reached, triggers forwarding.
 *
 * TODO: implement real confirmation counting via TronGrid's transaction query.
 * For MVP, poll the transaction status and increment confirmations each cycle
 * (TronGrid marks transactions as confirmed after ~1 block on TRON mainnet,
 * so this is mostly a formality — TRON's 3-second block time means 3
 * confirmations ≈ 9 seconds after detection).
 */
async function checkConfirmations(payment: Payment): Promise<void> {
  let txHash = payment.tx_hash;

  // If tx_hash is missing (common for unactivated addresses where TronGrid
  // returns no event data), try to look it up via the transfer event log.
  if (!txHash) {
    try {
      const sinceTs = payment.detected_at
        ? new Date(payment.detected_at).getTime() - 30_000
        : new Date(payment.created_at).getTime();
      const events = await getTransferEvents(payment.address, sinceTs);
      if (events.length > 0) {
        txHash = events[0].txHash;
        updatePaymentStatus(payment.id, 'detected', txHash, undefined);
        console.log(`[monitor] Resolved tx_hash for ${payment.id}: ${txHash}`);
      }
    } catch { /* non-fatal */ }
  }

  // If still no tx_hash but the payment has been in 'detected' state for >30s
  // (≥10 TRON blocks), the balance was already verified by getBalance() and
  // enough blocks have passed. Proceed to forwarding without the hash.
  if (!txHash) {
    const detectedMs = payment.detected_at
      ? Date.now() - new Date(payment.detected_at).getTime()
      : 0;
    if (detectedMs > 30_000) {
      console.log(
        `[monitor] Payment ${payment.id}: tx_hash unavailable after ${Math.round(detectedMs / 1000)}s` +
        ` — balance verified, proceeding to forward.`,
      );
      await handleConfirmed(payment);
    }
    return;
  }

  // Normal path: count confirmations via block height comparison.
  try {
    const tronGridUrl = process.env.TRON_RPC_URL ?? 'https://api.trongrid.io';
    const headers: Record<string, string> = {};
    if (process.env.TRON_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRON_API_KEY;

    const [txInfoRes, blockRes] = await Promise.all([
      axios.post(
        `${tronGridUrl}/wallet/gettransactioninfobyid`,
        { value: txHash },
        { headers, timeout: 5000 },
      ),
      axios.post(
        `${tronGridUrl}/wallet/getnowblock`,
        {},
        { headers, timeout: 5000 },
      ),
    ]);

    const txBlockNumber: number = txInfoRes.data?.blockNumber ?? 0;
    const currentBlock: number =
      blockRes.data?.block_header?.raw_data?.number ?? 0;

    if (txBlockNumber === 0) return;

    const confirmations = Math.max(0, currentBlock - txBlockNumber);
    updatePaymentStatus(payment.id, 'detected', undefined, confirmations);

    if (confirmations >= REQUIRED_CONFIRMATIONS) {
      await handleConfirmed(payment);
    }
  } catch (err) {
    console.warn(`[monitor] checkConfirmations(${payment.id}) failed:`, err);
  }
}

/**
 * handleConfirmed — A payment has reached confirmation threshold.
 *
 * Branches on the developer's payout_chain:
 *   'tron' → forward USDT directly on Tron (existing behaviour).
 *   'base' → initiate deBridge Tron→Base bridge; set status to 'bridging'.
 *            The polling loop checks bridge status and fires the webhook on fulfillment.
 */
async function handleConfirmed(payment: Payment): Promise<void> {
  const confirmedAt = new Date().toISOString();
  updatePaymentStatus(payment.id, 'confirmed', undefined, REQUIRED_CONFIRMATIONS);

  console.log(`[monitor] Payment ${payment.id} confirmed. Processing payout...`);

  recordConfirmation(
    payment.id,
    payment.created_at,
    payment.detected_at ?? payment.created_at,
    confirmedAt,
    payment.confirmations ?? REQUIRED_CONFIRMATIONS,
  );

  const developer = getDeveloperById(payment.developer_id);
  if (!developer) {
    console.error(`[monitor] Developer not found for payment ${payment.id}. Cannot forward.`);
    updatePaymentStatus(payment.id, 'failed');
    return;
  }

  if (developer.payout_chain === 'base') {
    await handleBasePayout(payment, developer);
  } else {
    await handleTronPayout(payment, developer);
  }

  releaseAddress(payment.address_index);
}

/**
 * handleTronPayout — Standard Tron USDT forwarding.
 */
async function handleTronPayout(
  payment: Payment,
  developer: import('../db/schema').Developer,
): Promise<void> {
  try {
    // Activate the destination address if it doesn't exist on-chain yet.
    // On Shasta, TRC-20 transfers to unactivated addresses fail with
    // "account does not exist". On mainnet this is usually not needed but
    // activateIfNeeded is a no-op if the address is already active.
    const activated = await activateIfNeeded(developer.receiving_address);
    if (!activated) {
      console.warn(`[monitor] Could not activate destination ${developer.receiving_address} — proceeding anyway.`);
    }

    const txHash = await forwardPayment(
      payment.address_index,
      developer.receiving_address,
      payment.amount_net,
    );
    updatePaymentStatus(payment.id, 'forwarded', txHash, REQUIRED_CONFIRMATIONS);
    console.log(`[monitor] Payment ${payment.id} forwarded on Tron. TX: ${txHash}`);
    const confirmSecs = payment.detected_at
      ? (Date.now() - new Date(payment.detected_at).getTime()) / 1000
      : 0;
    recordTransaction(payment.id, payment.amount_due, '0', confirmSecs);
    deliverWebhook(payment, developer).catch((err) => {
      console.error(`[monitor] Webhook delivery failed for payment ${payment.id}:`, err);
    });
  } catch (err) {
    console.error(`[monitor] Tron forwarding failed for payment ${payment.id}:`, err);
    updatePaymentStatus(payment.id, 'failed');
  }
}

/**
 * handleBasePayout — Bridge Tron USDT → Base USDC for developer payout.
 *
 * Stores the deBridge orderId in tx_hash so checkBridgeStatus() can poll it.
 * Status transitions to 'bridging'; the webhook fires when the bridge fulfills.
 */
async function handleBasePayout(
  payment: Payment,
  developer: import('../db/schema').Developer,
): Promise<void> {
  if (!developer.base_receiving_address) {
    console.error(`[monitor] Developer ${developer.id} payout_chain=base but no base_receiving_address.`);
    updatePaymentStatus(payment.id, 'failed');
    return;
  }

  try {
    // First sweep USDT from the payment address to the agent hot wallet (index 0).
    // This gets funds off the dedicated payment address so it can be released.
    const hotWalletAddress = await (await import('../wallet/tron')).getTronWalletAddress(0);
    await forwardPayment(payment.address_index, hotWalletAddress, payment.amount_net);

    // Initiate bridge from agent hot wallet to developer's Base address.
    const orderId = await bridgeTronToBase(payment.amount_net, developer.base_receiving_address);

    // Store orderId in tx_hash field so checkBridgeStatus() can retrieve it.
    updatePaymentStatus(payment.id, 'bridging', orderId, REQUIRED_CONFIRMATIONS);
    console.log(`[monitor] Payment ${payment.id} bridging to Base. deBridge orderId: ${orderId}`);
  } catch (err) {
    console.error(`[monitor] Base payout failed for payment ${payment.id}:`, err);
    updatePaymentStatus(payment.id, 'failed');
  }
}

/**
 * checkBridgeStatus — Poll deBridge DLN order status for a 'bridging' payment.
 *
 * Fires the webhook and transitions to 'forwarded' once the bridge fulfills.
 */
async function checkBridgeStatus(payment: Payment): Promise<void> {
  if (!payment.tx_hash) return; // orderId stored in tx_hash

  try {
    const order = await getBridgeOrderStatus(payment.tx_hash);
    if (order.status === 'fulfilled') {
      updatePaymentStatus(payment.id, 'forwarded', payment.tx_hash, REQUIRED_CONFIRMATIONS);
      console.log(`[monitor] Payment ${payment.id} bridge fulfilled. orderId: ${payment.tx_hash}`);
      const confirmSecs = payment.detected_at
        ? (Date.now() - new Date(payment.detected_at).getTime()) / 1000
        : 0;
      recordTransaction(payment.id, payment.amount_due, '0', confirmSecs);

      const developer = getDeveloperById(payment.developer_id);
      if (developer) {
        deliverWebhook(payment, developer).catch((err) => {
          console.error(`[monitor] Webhook delivery failed for payment ${payment.id}:`, err);
        });
      }
    } else if (order.status === 'orderCancelled') {
      console.error(`[monitor] Bridge order cancelled for payment ${payment.id}. orderId: ${payment.tx_hash}`);
      updatePaymentStatus(payment.id, 'failed');
    }
    // Otherwise keep polling in next cycle.
  } catch (err) {
    console.warn(`[monitor] checkBridgeStatus(${payment.id}) failed:`, err);
  }
}
