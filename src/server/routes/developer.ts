/**
 * src/server/routes/developer.ts — Developer registration routes
 *
 * These routes are free (no x402 gate). A developer registers once and
 * receives an API key used for all subsequent authenticated requests.
 *
 * Authentication middleware (authenticateDeveloper) is exported from here
 * for use in other route files that need to identify the calling developer.
 *
 * TRON address validation:
 *   TRON addresses are base58check encoded and always start with 'T',
 *   followed by 33 more base58 characters (34 chars total).
 *   The validation regex below checks format only; it does NOT verify that
 *   the address actually exists on-chain.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { registerDeveloper, getDeveloperByApiKey } from '../../db/queries/developers';
import type { Developer } from '../../db/schema';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const RegisterSchema = z
  .object({
    /** The TRON address where the developer wants to receive USDT after relaying. */
    receivingAddress: z
      .string()
      .regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/, 'Invalid TRON address format'),
    /** URL that will receive POST webhook notifications on payment events. */
    webhookUrl: z.string().url('Must be a valid URL'),
    /**
     * Secret used to sign webhook payloads (HMAC-SHA256).
     * Developers should generate a strong random string (min 32 chars).
     */
    webhookSecret: z.string().min(16, 'Webhook secret must be at least 16 characters'),
    /**
     * Which chain to receive payouts on.
     * 'tron' (default) — USDT directly on Tron, no extra bridge fee.
     * 'base'           — USDC on Base via deBridge DLN; requires baseReceivingAddress.
     */
    payoutChain: z.enum(['tron', 'base']).optional().default('tron'),
    /**
     * Base address (0x...) for USDC payout. Required when payoutChain = 'base'.
     */
    baseReceivingAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid Base/EVM address format')
      .optional(),
  })
  .refine(
    (data) => data.payoutChain !== 'base' || !!data.baseReceivingAddress,
    { message: 'baseReceivingAddress is required when payoutChain is "base"', path: ['baseReceivingAddress'] },
  );

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * developerRoutes — Register developer routes on the Fastify instance.
 *
 * Mounted at /developer by src/server/index.ts.
 */
export async function developerRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /developer/register
   *
   * Creates a new developer account. Returns the API key exactly once.
   * The developer must store this key — it cannot be recovered if lost.
   *
   * Response: { developerId, apiKey, receivingAddress }
   */
  fastify.post('/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = RegisterSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { receivingAddress, webhookUrl, webhookSecret, payoutChain, baseReceivingAddress } = parseResult.data;

    const { developer, apiKey } = registerDeveloper({
      receivingAddress,
      webhookUrl,
      webhookSecret,
      payoutChain,
      baseReceivingAddress,
    });

    return reply.status(201).send({
      developerId: developer.id,
      apiKey,
      receivingAddress: developer.receiving_address,
      payoutChain: developer.payout_chain,
      ...(developer.base_receiving_address && { baseReceivingAddress: developer.base_receiving_address }),
      message:
        'Developer registered. Store your apiKey securely — it will not be shown again. ' +
        'Pass it as the X-Api-Key header on all subsequent requests.',
    });
  });

  /**
   * GET /developer/me
   *
   * Returns the authenticated developer's profile. Requires X-Api-Key header.
   * Useful for verifying that a key is valid.
   */
  fastify.get(
    '/me',
    { preHandler: [authenticateDeveloper] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const developer = (request as AuthenticatedRequest).developer;
      return reply.send({
        id: developer.id,
        receivingAddress: developer.receiving_address,
        webhookUrl: developer.webhook_url,
        createdAt: developer.created_at,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Authentication middleware
// ---------------------------------------------------------------------------

/** Extends FastifyRequest to carry the authenticated developer object. */
export interface AuthenticatedRequest extends FastifyRequest {
  developer: Developer;
}

/**
 * authenticateDeveloper — Fastify preHandler that validates X-Api-Key.
 *
 * Attaches the `developer` object to the request for use in route handlers.
 * Returns 401 if the key is missing or invalid.
 * Returns 403 if the developer account is inactive.
 *
 * Usage:
 *   fastify.post('/route', { preHandler: [authenticateDeveloper] }, handler);
 */
export async function authenticateDeveloper(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const apiKey = request.headers['x-api-key'];

  if (!apiKey || typeof apiKey !== 'string') {
    return reply.status(401).send({ error: 'Missing X-Api-Key header.' });
  }

  const developer = getDeveloperByApiKey(apiKey);

  if (!developer) {
    return reply.status(401).send({ error: 'Invalid or inactive API key.' });
  }

  // Attach developer to request for downstream use.
  (request as AuthenticatedRequest).developer = developer;
}
