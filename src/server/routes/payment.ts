/**
 * src/server/routes/payment.ts — Payment relay routes
 *
 * Two endpoints:
 *
 *   POST /payment/create — x402 gated at $0.01 USDC
 *     Creates a new payment request. The developer pays $0.01 per payment
 *     request via x402 in addition to the relay fee on the actual USDT
 *     transfer. This ensures the relay covers its operating costs even if
 *     the user never sends payment.
 *
 *   GET /payment/:id/status — free (polling fallback)
 *     Returns current payment status. Developers should use webhooks as the
 *     primary notification mechanism; this endpoint is the fallback for
 *     clients that can't receive webhooks (e.g., mobile apps).
 *
 * Amount due calculation:
 *   amount_due = amount + relay_fee + sponsorship_estimate
 *
 *   relay_fee = amount * (RELAY_FEE_PERCENT / 100)
 *   sponsorship_estimate = from energy intelligence service (in USDT equivalent)
 *   amount_net = amount_due - relay_fee - sponsorship_estimate = amount (what developer receives)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createX402Gate } from '../middleware/x402';
import { authenticateDeveloper, AuthenticatedRequest } from './developer';
import { acquireAddress } from '../../relay/addressPool';
import { createPayment, getPayment } from '../../db/queries/payments';
import { calculateSponsorshipCost } from '../../relay/gasless';
import { getSettingAsFloat, SETTING_KEYS } from '../../db/queries/settings';

// ---------------------------------------------------------------------------
// Runtime config (can be updated by the agent via the update_fee tool)
// ---------------------------------------------------------------------------

/**
 * runtimeConfig — Mutable runtime configuration values.
 *
 * The agent may call updateFee() (src/agent/tools/pricing.ts) to change
 * RELAY_FEE_PERCENT. Changes are applied immediately for new payment requests.
 * This object is the single source of truth for the current fee at runtime.
 *
 * Initialisation priority:
 *   1. DB settings table (persisted by the agent across restarts)
 *   2. RELAY_FEE_PERCENT env var (initial default)
 *   3. Hardcoded fallback of 0.3%
 *
 * This means an agent-set fee survives restarts without requiring a board meeting
 * to re-establish it.
 */
/**
 * Lazy initialisation: reads from DB on first access so that the module can be
 * required before initDb() has run without triggering a SqliteError.
 */
let _relayFeePercent: number | undefined;

export const runtimeConfig = {
  get relayFeePercent(): number {
    if (_relayFeePercent === undefined) {
      _relayFeePercent = getSettingAsFloat(
        SETTING_KEYS.RELAY_FEE_PERCENT,
        parseFloat(process.env.RELAY_FEE_PERCENT ?? '0.3'),
      );
    }
    return _relayFeePercent;
  },
  set relayFeePercent(value: number) {
    _relayFeePercent = value;
  },
};

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreatePaymentSchema = z.object({
  /** Amount the end user should pay. The relay will add fees on top. */
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, 'Amount must be a positive decimal string')
    .refine(
      (v) => parseFloat(v) >= parseFloat(process.env.MIN_PAYMENT_USDT ?? '1.00'),
      `Amount must be at least ${process.env.MIN_PAYMENT_USDT ?? '1.00'} USDT`,
    ),
  currency: z.literal('USDT'),
  /** Developer's own reference for this order. Returned in webhooks. */
  orderId: z.string().min(1).max(128),
  /** How long to keep this payment address open before expiring (minutes). */
  expiresInMinutes: z.number().int().min(5).max(1440).default(30),
  /**
   * Optional hint: true if the end user is known to have TRX in their wallet.
   * When true, the relay skips adding the sponsorship cost estimate to amount_due,
   * which lowers the total for users who can pay their own energy fees.
   */
  senderHasTrx: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function paymentRoutes(fastify: FastifyInstance): Promise<void> {
  const x402Gate = createX402Gate({
    price: '0.01',
    currency: 'USDC',
    network: 'base',
    description: 'Payment relay request fee',
  });

  /**
   * POST /payment/create
   *
   * Creates a new USDT payment request on TRON.
   *
   * Request headers:
   *   X-Api-Key: <developer api key>
   *   X-Payment: <x402 payment proof>   ← required unless in dev mode
   *
   * Request body: { amount, currency, orderId, expiresInMinutes? }
   *
   * Response: {
   *   id, address, amountDue, currency, network,
   *   expiresAt, gasless, relayFeePercent
   * }
   *
   * The user should send exactly `amountDue` USDT to `address`.
   * Partial payments are not accepted.
   */
  fastify.post(
    '/create',
    { preHandler: [x402Gate, authenticateDeveloper] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const developer = (request as AuthenticatedRequest).developer;

      const parseResult = CreatePaymentSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: parseResult.error.flatten().fieldErrors,
        });
      }

      const { amount, currency, orderId, expiresInMinutes, senderHasTrx } = parseResult.data;

      // --- Calculate amount_due -------------------------------------------
      const amountNum = parseFloat(amount);
      const relayFee = amountNum * (runtimeConfig.relayFeePercent / 100);

      // Add sponsorship cost unless the developer signals the user has TRX.
      // When senderHasTrx=true, the user pays their own energy and we skip
      // the estimate entirely, lowering the total by ~$0.01–0.05 per tx.
      let sponsorshipCostUsdt = 0;
      if (!senderHasTrx) {
        const sponsorshipCostTrx = await calculateSponsorshipCost('unknown');
        const { getLatestEnergyData } = await import('../../intelligence/energy');
        const energyData = getLatestEnergyData();
        const trxPriceUsd = energyData?.trxPriceUsd ?? 0.085;
        sponsorshipCostUsdt = parseFloat(sponsorshipCostTrx) * trxPriceUsd;
      }

      const amountDue = (amountNum + relayFee + sponsorshipCostUsdt).toFixed(6);
      const amountNet = amountNum.toFixed(6); // developer receives the base amount

      // --- Acquire address from pool ---------------------------------------
      const addressEntry = acquireAddress(orderId);
      if (!addressEntry) {
        // Pool is depleted — trigger async pool growth and ask client to retry.
        const { growPool } = await import('../../relay/addressPool');
        growPool(30).catch((e: unknown) =>
          fastify.log.error({ err: e }, '[payment] Pool growth failed'),
        );
        return reply.status(503).send({
          error: 'Service temporarily unavailable — address pool depleted. Retry in a few seconds.',
        });
      }

      // --- Create payment record ------------------------------------------
      const expiresAt = new Date(
        Date.now() + expiresInMinutes * 60 * 1000,
      ).toISOString();

      const payment = createPayment({
        developerId: developer.id,
        orderId,
        address: addressEntry.address,
        addressIndex: addressEntry.idx,  // `idx` matches the SQL column name
        amountDue,
        amountNet,
        expiresAt,
      });

      return reply.status(201).send({
        id: payment.id,
        address: payment.address,
        amountDue: payment.amount_due,
        amountNet: payment.amount_net,
        currency,
        network: 'tron',
        expiresAt: payment.expires_at,
        gasless: !senderHasTrx, // false when caller signals user has TRX
        relayFeePercent: runtimeConfig.relayFeePercent,
        message: `Send exactly ${payment.amount_due} ${currency} to ${payment.address} on TRON (TRC-20) before ${payment.expires_at}.`,
      });
    },
  );

  /**
   * GET /payment/:id/status
   *
   * Free endpoint — no x402 gate, no authentication required.
   * Anyone with the payment ID can poll for status. Payment IDs are UUIDs;
   * they are hard to enumerate, which provides reasonable privacy by obscurity.
   *
   * For a production deployment, consider requiring the developer's API key
   * for status lookups to prevent enumeration.
   */
  fastify.get(
    '/:id/status',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const payment = getPayment(request.params.id);

      if (!payment) {
        return reply.status(404).send({ error: 'Payment not found.' });
      }

      return reply.send({
        id: payment.id,
        orderId: payment.order_id,
        status: payment.status,
        address: payment.address,
        amountDue: payment.amount_due,
        amountNet: payment.amount_net,
        currency: payment.currency,
        txHash: payment.tx_hash,
        confirmations: payment.confirmations,
        createdAt: payment.created_at,
        confirmedAt: payment.confirmed_at,
        expiresAt: payment.expires_at,
      });
    },
  );
}
