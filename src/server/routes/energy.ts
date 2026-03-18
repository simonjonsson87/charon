/**
 * src/server/routes/energy.ts — TRON energy intelligence API routes
 *
 * These endpoints monetise the relay's energy market intelligence via x402.
 * The data is useful to developers who want to display accurate gas cost
 * estimates in their UIs or decide whether to batch transactions.
 *
 * Pricing:
 *   $0.002 USDC per request — fractional micropayment enabled by x402.
 *   This is priced to be cheap enough that any developer will use it
 *   without hesitation, while still generating meaningful revenue at volume.
 *
 * Data freshness:
 *   The energy data is cached in memory and refreshed every 5 minutes by
 *   the intelligence/energy service. These endpoints serve from the cache;
 *   they do NOT trigger a fresh fetch. The `recordedAt` field in the response
 *   tells the developer how old the data is.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createX402Gate } from '../middleware/x402';
import { getLatestEnergyData, estimateForOperation } from '../../intelligence/energy';
import type { OperationType } from '../../intelligence/energy';

export async function energyRoutes(fastify: FastifyInstance): Promise<void> {
  const energyGate = createX402Gate({
    price: '0.002',
    currency: 'USDC',
    network: 'base',
    description: 'TRON energy market data',
  });

  /**
   * GET /energy/price
   *
   * Returns the latest TRON energy market snapshot:
   *   - TRX price in USD
   *   - Energy price in SUN (from TRON RPC)
   *   - Cost per USDT transfer from TronSave, TR.ENERGY, and burn
   *   - Recommended cheapest provider with savings percentage
   *   - Human-readable LLM-generated recommendation (cached, not generated per-request)
   *
   * Returns 503 if the energy data has not been initialised yet.
   */
  fastify.get(
    '/price',
    { preHandler: [energyGate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const data = getLatestEnergyData();

      if (!data) {
        return reply.status(503).send({
          error: 'Energy data not yet available. The service is still initialising.',
        });
      }

      return reply.send({
        recordedAt: data.recordedAt,
        trxPriceUsd: data.trxPriceUsd,
        energyPriceSun: data.energyPriceSun,
        providers: {
          tronsave: { costTrx: data.tronsaveCostTrx },
          trenergy: { costTrx: data.trenergyCostTrx },
          burn: { costTrx: data.burnCostTrx },
        },
        recommended: {
          provider: data.recommendedProvider,
          savingsPercent: data.savingsPercent,
        },
        recommendation: data.recommendation,
      });
    },
  );

  /**
   * GET /energy/estimate
   *
   * Returns a cost estimate for a specific operation type and quantity.
   *
   * Query params:
   *   operation: 'usdt_transfer' (default) | 'usdt_approval'
   *   quantity: number (default: 1)
   *
   * Response: {
   *   operation, quantity, provider,
   *   trxCost (total TRX for all operations),
   *   usdCost (USD equivalent)
   * }
   */
  const EstimateQuerySchema = z.object({
    operation: z.enum(['usdt_transfer', 'usdt_approval']).default('usdt_transfer'),
    quantity: z.coerce.number().int().min(1).max(10_000).default(1),
  });

  fastify.get(
    '/estimate',
    { preHandler: [energyGate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = EstimateQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Invalid query parameters',
          details: parseResult.error.flatten().fieldErrors,
        });
      }

      const { operation, quantity } = parseResult.data;

      const estimate = estimateForOperation(operation as OperationType, quantity);

      if (!estimate) {
        return reply.status(503).send({
          error: 'Energy data not yet available.',
        });
      }

      return reply.send({
        operation,
        quantity,
        provider: estimate.provider,
        trxCost: estimate.trxCost.toFixed(6),
        usdCost: estimate.usdCost.toFixed(6),
      });
    },
  );
}
