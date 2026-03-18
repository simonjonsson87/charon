/**
 * src/relay/webhook.ts — Outbound webhook delivery
 *
 * When a payment is confirmed and forwarded, the relay notifies the developer
 * by POSTing a signed payload to their registered webhookUrl.
 *
 * Security: the payload is signed with HMAC-SHA256 using the developer's
 * webhookSecret. The signature is sent in the X-Webhook-Signature header as
 * "sha256=<hex_digest>". Developers should verify this header before
 * processing the webhook. This is the same scheme used by GitHub and Stripe.
 *
 * Retry policy: if delivery fails (non-2xx response or network error), the
 * system retries WEBHOOK_RETRY_COUNT times at WEBHOOK_RETRY_INTERVAL_MS
 * intervals. After all retries are exhausted, the failure is logged but the
 * payment is not marked as failed — the payment itself succeeded; only the
 * notification failed. Developers can poll GET /payment/:id/status as a
 * fallback.
 *
 * TODO: move retry logic to a persistent job queue (e.g., backed by the
 * SQLite DB) so retries survive process restarts. Currently retries are
 * in-memory only and are lost if the process crashes.
 */

import crypto from 'crypto';
import axios from 'axios';
import type { Payment, Developer } from '../db/schema';

const RETRY_COUNT = parseInt(process.env.WEBHOOK_RETRY_COUNT ?? '5', 10);
const RETRY_INTERVAL_MS = parseInt(process.env.WEBHOOK_RETRY_INTERVAL_MS ?? '10000', 10);

/** The payload shape sent to developer webhook endpoints. */
export interface WebhookPayload {
  /** Payment UUID — matches the id returned at payment creation. */
  id: string;
  /** The developer's own order reference. */
  orderId: string;
  status: 'confirmed' | 'forwarded' | 'failed' | 'expired';
  /** TRON transaction hash of the forwarding transaction. Null for failed/expired. */
  txHash: string | null;
  /** Amount received from the user (gross, before relay fee). */
  amountReceived: string;
  /** Amount forwarded to developer (net, after relay fee). */
  amountNet: string;
  currency: string;
  confirmedAt: string | null;
  /** Unix timestamp (ms) when this webhook was sent. */
  sentAt: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * deliverWebhook — Send a payment event notification to the developer.
 *
 * Handles HMAC signing and retry logic. Returns when delivery succeeds or
 * all retries are exhausted. Does not throw — caller should not crash on
 * webhook delivery failure.
 */
export async function deliverWebhook(
  payment: Payment,
  developer: Developer,
): Promise<void> {
  const payload: WebhookPayload = {
    id: payment.id,
    orderId: payment.order_id,
    status: payment.status as WebhookPayload['status'],
    txHash: payment.tx_hash,
    amountReceived: payment.amount_due, // user sent amount_due
    amountNet: payment.amount_net,
    currency: payment.currency,
    confirmedAt: payment.confirmed_at,
    sentAt: Date.now(),
  };

  const body = JSON.stringify(payload);
  const signature = signPayload(body, developer.webhook_secret);

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    const success = await attemptDelivery(developer.webhook_url, body, signature, attempt);
    if (success) return;

    if (attempt < RETRY_COUNT) {
      await sleep(RETRY_INTERVAL_MS);
    }
  }

  console.error(
    `[webhook] Delivery permanently failed for payment ${payment.id} after ${RETRY_COUNT} attempts.`,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * signPayload — Compute HMAC-SHA256 signature for a webhook body.
 *
 * Returns the signature in the format "sha256=<hex_digest>" which mirrors
 * the GitHub webhook signature format. Developers check this header:
 *
 *   const expected = `sha256=${hmac(secret, body)}`;
 *   if (!timingSafeEqual(expected, req.headers['x-webhook-signature'])) reject();
 */
function signPayload(body: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * attemptDelivery — Make a single HTTP POST attempt to the webhook URL.
 *
 * Returns true on 2xx response, false on any error (network or non-2xx status).
 * Logs the attempt and outcome at each retry.
 */
async function attemptDelivery(
  url: string,
  body: string,
  signature: string,
  attempt: number,
): Promise<boolean> {
  try {
    const response = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'User-Agent': 'charon/0.1.0',
      },
      timeout: 10_000, // 10 second timeout per attempt
      validateStatus: (status) => status >= 200 && status < 300,
    });

    console.log(`[webhook] Delivered (attempt ${attempt}). Status: ${response.status}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[webhook] Delivery attempt ${attempt} failed: ${message}`);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
