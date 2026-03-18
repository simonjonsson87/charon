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
import { getTransferEvents } from '../wallet/tron';
import { forwardPayment } from '../wallet/tron';
import { bridgeTronToBase, getBridgeOrderStatus } from '../wallet/bridge';
import { releaseAddress } from './addressPool';
import { sponsorIfNeeded } from './gasless';
import { deliverWebhook } from './webhook';
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
 * checkForIncomingTransfer — Look for new USDT arriving at a pending payment address.
 *
 * Queries TronGrid for TRC-20 Transfer events targeting this address since
 * the last poll. If a transfer with amount >= amountDue is found, transitions
 * the payment to 'detected' and triggers energy sponsorship if needed.
 */
async function checkForIncomingTransfer(payment: Payment): Promise<void> {
  const sinceTimestamp = lastPolledAt.get(payment.address) ?? Date.now() - 60_000;

  // Skip polling if we're in a rate-limit backoff window.
  if (Date.now() < rateLimitBackoffUntil) return;

  let events;
  try {
    events = await getTransferEvents(payment.address, sinceTimestamp);
    rateLimitConsecutive = 0; // reset on success
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
  lastPolledAt.set(payment.address, Date.now());

  for (const event of events) {
    const received = parseFloat(event.amount);
    const due = parseFloat(payment.amount_due);

    if (received < due) {
      // Under-payment: do not accept. Log for visibility.
      console.warn(
        `[monitor] Under-payment on ${payment.id}: received ${received}, due ${due}. Ignoring.`,
      );
      continue;
    }

    console.log(`[monitor] Payment ${payment.id} detected. TX: ${event.txHash}`);

    // Transition to detected.
    updatePaymentStatus(payment.id, 'detected', event.txHash, 0);

    // Sponsor energy before the user's transfer confirms if the address needs it.
    await sponsorIfNeeded(payment.address, payment.id);

    break; // Only process the first qualifying transfer per poll cycle.
  }
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
  if (!payment.tx_hash) return;

  try {
    const tronGridUrl = process.env.TRON_RPC_URL ?? 'https://api.trongrid.io';
    const headers: Record<string, string> = {};
    if (process.env.TRON_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRON_API_KEY;

    // Fetch transaction info to get the block number it was included in.
    const [txInfoRes, blockRes] = await Promise.all([
      axios.post(
        `${tronGridUrl}/wallet/gettransactioninfobyid`,
        { value: payment.tx_hash },
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

    // Fallback: if the tx isn't in a block yet, keep current count.
    if (txBlockNumber === 0) return;

    const confirmations = Math.max(0, currentBlock - txBlockNumber);
    updatePaymentStatus(payment.id, 'detected', undefined, confirmations);

    if (confirmations >= REQUIRED_CONFIRMATIONS) {
      await handleConfirmed(payment);
    }
  } catch (err) {
    // Non-fatal — the next poll cycle will retry.
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
    const txHash = await forwardPayment(
      payment.address_index,
      developer.receiving_address,
      payment.amount_net,
    );
    updatePaymentStatus(payment.id, 'forwarded', txHash, REQUIRED_CONFIRMATIONS);
    console.log(`[monitor] Payment ${payment.id} forwarded on Tron. TX: ${txHash}`);
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
