/**
 * src/server/routes/network.ts — TRON network timing intelligence API
 *
 * Exposes the real-time network timing signal assembled by the intelligence
 * layer in src/intelligence/network.ts.
 *
 * Route map:
 *   GET /network/timing  → current stats, confirmation percentiles, 24h forecast
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { getTimingSignal } from '../../intelligence/network';

export async function networkRoutes(
  fastify: FastifyInstance,
  _options: FastifyPluginOptions,
): Promise<void> {

  // ---- GET /network/timing -------------------------------------------------
  /**
   * Returns the current TRON network timing intelligence:
   *   - Live TPS and block time (polled every 30s from TronGrid)
   *   - Confirmation time percentiles (p50/p95/p99) from this relay's own history
   *   - 24-hour hourly forecast with expected load levels
   *   - LLM-generated narrative (regenerated at most once per hour)
   *
   * Returns 503 if the network monitor hasn't collected its first sample yet
   * (typically resolves within a few seconds of startup).
   */
  fastify.get('/timing', async (_request, reply) => {
    const signal = await getTimingSignal();

    if (!signal) {
      return reply.status(503).send({
        error: 'Network stats not yet available. The monitor is initialising — retry in a few seconds.',
      });
    }

    return signal;
  });
}
