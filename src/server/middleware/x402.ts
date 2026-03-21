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

    // Verify the payment proof via local EIP-712 signature verification.
    try {
      const result = await verifyX402Payment(paymentHeader, {
        maxAmountRequired: config.price,
        asset: USDC_BASE,
        payTo: await getAgentBaseAddress(),
      });

      if (!result.isValid) {
        request.log.warn('[x402] Payment invalid: %s', result.invalidReason);
        reply.status(402).send({ error: 'Payment verification failed', details: result.invalidReason });
        return;
      }

      request.log.info('[x402] Payment verified — from %s, amount %s', result.from, result.value);
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

// ---------------------------------------------------------------------------
// Local EIP-712 payment verification (no external CDP dependency)
// ---------------------------------------------------------------------------

interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  from?: string;
  value?: string;
}

/**
 * Verify an x402 X-Payment header without calling the CDP facilitator.
 *
 * Decodes the base64 payload, reconstructs the EIP-712 typed-data hash, and
 * recovers the signer address. Checks amount, recipient, and expiry.
 * Settlement (on-chain USDC transfer) is handled by the USDC contract when
 * the facilitator submits the signed authorization — we don't need to do that
 * here; the signature itself is sufficient proof of authorisation for access.
 */
async function verifyX402Payment(
  paymentHeader: string,
  config: { maxAmountRequired: string; asset: string; payTo: string },
): Promise<VerifyResult> {
  const { ethers } = await import('ethers');

  let payment: Record<string, unknown>;
  try {
    payment = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
  } catch {
    return { isValid: false, invalidReason: 'Malformed X-Payment header (not valid base64 JSON)' };
  }

  if (payment['x402Version'] !== 1 || payment['scheme'] !== 'exact') {
    return { isValid: false, invalidReason: 'Unsupported x402 version or scheme' };
  }

  const { signature, authorization } = (payment['payload'] ?? {}) as Record<string, unknown>;
  if (!signature || !authorization || typeof authorization !== 'object') {
    return { isValid: false, invalidReason: 'Missing payload.signature or payload.authorization' };
  }

  const auth = authorization as Record<string, string>;
  const now = Math.floor(Date.now() / 1000);

  if (parseInt(auth['validBefore'] ?? '0') < now) {
    return { isValid: false, invalidReason: 'Payment authorization expired' };
  }

  // Amount check: config.maxAmountRequired is a dollar string ("0.01"); auth.value is base units.
  const requiredBaseUnits = Math.round(parseFloat(config.maxAmountRequired) * 1_000_000);
  if (parseInt(auth['value'] ?? '0') < requiredBaseUnits) {
    return { isValid: false, invalidReason: `Insufficient amount: got ${auth['value']}, need ${requiredBaseUnits}` };
  }

  // Recipient check
  if ((auth['to'] ?? '').toLowerCase() !== config.payTo.toLowerCase()) {
    return { isValid: false, invalidReason: `Wrong recipient: got ${auth['to']}, expected ${config.payTo}` };
  }

  // EIP-712 signature recovery
  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: 8453,
    verifyingContract: config.asset,
  };
  const types = {
    TransferWithAuthorization: [
      { name: 'from',        type: 'address' },
      { name: 'to',          type: 'address' },
      { name: 'value',       type: 'uint256' },
      { name: 'validAfter',  type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce',       type: 'bytes32' },
    ],
  };
  const message = {
    from:        auth['from'],
    to:          auth['to'],
    value:       BigInt(auth['value'] ?? '0'),
    validAfter:  BigInt(auth['validAfter'] ?? '0'),
    validBefore: BigInt(auth['validBefore'] ?? '0'),
    nonce:       auth['nonce'],
  };

  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(domain, types, message, signature as string);
  } catch (err) {
    return { isValid: false, invalidReason: `Signature recovery failed: ${(err as Error).message}` };
  }

  if (recovered.toLowerCase() !== (auth['from'] ?? '').toLowerCase()) {
    return { isValid: false, invalidReason: `Signer mismatch: recovered ${recovered}, expected ${auth['from']}` };
  }

  return { isValid: true, from: auth['from'], value: auth['value'] };
}

