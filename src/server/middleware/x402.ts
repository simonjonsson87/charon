/**
 * src/server/middleware/x402.ts — x402 payment gate factory
 *
 * x402 is a payment protocol built on HTTP 402 ("Payment Required").
 * Flow for a gated endpoint:
 *
 *   1. Client sends request without payment.
 *   2. Server responds 402 + JSON payment requirement
 *      (amount, currency, network, recipient, expiry).
 *   3. Client pays on-chain (USDC on Base) and retries, including a signed
 *      payment proof in the X-Payment header.
 *   4. This middleware verifies the proof via the CDP facilitator.
 *   5. If valid, the request proceeds to the route handler.
 *   6. Server acknowledges in the X-Payment-Response header.
 *
 * Settlement:
 *   Payment lands as USDC in the agent's EVM wallet on Base.
 *   The daily consolidation cron (scheduler.ts) swaps USDC → USDT for Aave.
 *
 * Payment verification uses @coinbase/x402's verifyPayment() and
 * settlePayment() utilities against the CDP facilitator endpoint.
 *
 * Development mode:
 *   If CDP_API_KEY_NAME / CDP_API_KEY_PRIVATE_KEY are not set, the gate is
 *   bypassed with a warning. This allows local development without on-chain
 *   payments.
 */

import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';

// USDC on Base — the standard x402 payment token
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export interface X402GateConfig {
  /** Payment amount as a decimal string, e.g. "0.002" for $0.002 USDC. */
  price: string;
  /** Token to accept. Currently only USDC is supported via x402. */
  currency: 'USDC';
  /** Network where payment occurs. */
  network: 'base';
  /** Optional: route-level description returned in the 402 response. */
  description?: string;
}

/**
 * createX402Gate — Returns a Fastify preHandler that enforces x402 payment.
 *
 * Usage:
 *   const gate = createX402Gate({ price: '0.002', currency: 'USDC', network: 'base' });
 *   fastify.get('/energy/price', { preHandler: [gate] }, handler);
 */
export function createX402Gate(config: X402GateConfig): preHandlerHookHandler {
  return async function x402Gate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Bypass in development (no CDP keys configured).
    const cdpKeyName = process.env.CDP_API_KEY_NAME;
    const cdpKeyPrivate = process.env.CDP_API_KEY_PRIVATE_KEY;

    if (!cdpKeyName || !cdpKeyPrivate) {
      request.log.warn('[x402] CDP keys not set — payment gate bypassed (development mode).');
      return;
    }

    const paymentHeader = request.headers['x-payment'] as string | undefined;

    if (!paymentHeader) {
      // No payment provided — return 402 with payment requirements.
      // The agent's Base address is the payment recipient.
      let payTo: string;
      try {
        payTo = await getAgentBaseAddress();
      } catch {
        // If wallet isn't ready yet, return 503 rather than a broken 402.
        reply.status(503).send({ error: 'Payment service not yet initialised.' });
        return;
      }

      reply.status(402).send({
        x402Version: 1,
        error: 'Payment required',
        accepts: [
          {
            scheme: 'exact',
            network: config.network,
            maxAmountRequired: config.price,
            resource: request.url,
            description: config.description ?? 'API access',
            mimeType: 'application/json',
            payTo,
            maxTimeoutSeconds: 300,
            asset: USDC_BASE,
            extra: { name: 'USDC', version: '2' },
          },
        ],
      });
      return;
    }

    // Verify the payment proof via the CDP facilitator.
    try {
      // @ts-ignore — @coinbase/x402 ships ESM types incompatible with current moduleResolution
      const { verifyPayment, settlePayment } = await import('@coinbase/x402');

      const verifyResult = await verifyPayment(paymentHeader, {
        network: config.network,
        maxAmountRequired: config.price,
        asset: USDC_BASE,
        cdpApiKeyName: cdpKeyName,
        cdpApiKeyPrivateKey: cdpKeyPrivate,
      });

      if (!verifyResult.isValid) {
        reply.status(402).send({ error: 'Payment verification failed', details: verifyResult.invalidReason });
        return;
      }

      // Settle the payment (broadcasts the proof on-chain if needed).
      const settleResult = await settlePayment(paymentHeader, {
        cdpApiKeyName: cdpKeyName,
        cdpApiKeyPrivateKey: cdpKeyPrivate,
      });

      // Attach the settlement response to the reply headers for the client.
      if (settleResult.responseHeader) {
        void reply.header('X-Payment-Response', settleResult.responseHeader);
      }
    } catch (err) {
      request.log.error({ err }, '[x402] Payment verification error.');
      reply.status(402).send({ error: 'Payment processing failed. Please retry.' });
    }
  };
}

// ---------------------------------------------------------------------------
// Agent Base address helper
// ---------------------------------------------------------------------------

let _cachedBaseAddress: string | null = null;

async function getAgentBaseAddress(): Promise<string> {
  if (_cachedBaseAddress) return _cachedBaseAddress;
  const { getWalletAddress: getAddr } = await import('../../wallet/evm');
  _cachedBaseAddress = await getAddr('base');
  return _cachedBaseAddress;
}

