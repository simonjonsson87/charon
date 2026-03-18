/**
 * src/server/index.ts — Fastify HTTP server setup
 *
 * Responsibilities:
 *   - Create and configure the Fastify instance.
 *   - Register global middleware (CORS, x402 facilitator).
 *   - Mount route handlers.
 *   - Expose startServer() / stopServer() called by src/index.ts.
 *
 * x402 integration:
 *   The @coinbase/x402-fastify plugin is registered globally. Individual
 *   routes that require payment gates use the createX402Gate() helper from
 *   src/server/middleware/x402.ts to register a preHandler for that route.
 *   Routes that are free (developer registration, payment status polling)
 *   do not register the preHandler and are not gated.
 */

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
// x402-fastify is optional — payment gates degrade gracefully when CDP keys are absent.
// import { x402Fastify } from '@coinbase/x402-fastify';

import { developerRoutes } from './routes/developer';
import { paymentRoutes } from './routes/payment';
import { energyRoutes } from './routes/energy';
import { networkRoutes } from './routes/network';
import { internalRoutes } from './routes/internal';
import { adminRoutes } from './routes/admin';

let server: FastifyInstance | null = null;

/**
 * startServer — Create the Fastify instance, register all plugins and routes,
 * and start listening.
 *
 * Called once by src/index.ts. Returns when the server is ready to accept
 * connections.
 */
export async function startServer(port: number): Promise<void> {
  server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    // Suppress the default JSON access logs — we emit a readable one-liner instead.
    disableRequestLogging: true,
  });

  // Human-readable access log: [fastify] METHOD /path → STATUS (Xms)
  server.addHook('onResponse', (request, reply, done) => {
    const ms = reply.elapsedTime.toFixed(1);
    console.log(`[fastify] ${request.method} ${request.url} → ${reply.statusCode} (${ms}ms)`);
    done();
  });

  // ---- CORS ---------------------------------------------------------------
  // Allow all origins for the API. Tighten this in production if the API is
  // only accessed by server-side clients.
  await server.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  // ---- x402 ---------------------------------------------------------------
  // Payment gates are enforced per-route via createX402Gate() preHandlers
  // in the route files. The x402-fastify plugin is optional infrastructure
  // that provides shared request context; we skip it here and call the
  // verifyPayment/settlePayment utilities directly in the middleware.
  // When @coinbase/x402-fastify is confirmed compatible, this can be
  // registered for cleaner integration:
  //
  // if (process.env.CDP_API_KEY_NAME) {
  //   await server.register(x402Fastify, {
  //     cdpApiKeyName: process.env.CDP_API_KEY_NAME,
  //     cdpApiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY,
  //   });
  // }

  // ---- Routes -------------------------------------------------------------
  await server.register(developerRoutes, { prefix: '/developer' });
  await server.register(paymentRoutes, { prefix: '/payment' });
  await server.register(energyRoutes, { prefix: '/energy' });
  await server.register(networkRoutes, { prefix: '/network' });
  // Internal routes called by openclaw-bridge — localhost-only, not public.
  await server.register(internalRoutes, { prefix: '/internal' });
  // Admin/debug routes — protected by ADMIN_API_KEY, or localhost-only if key not set.
  await server.register(adminRoutes, { prefix: '/admin' });

  // ---- Health check -------------------------------------------------------
  server.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ---- Error handler ------------------------------------------------------
  server.setErrorHandler((error, _request, reply) => {
    server?.log.error(error);
    reply.status(error.statusCode ?? 500).send({
      error: error.name,
      message: error.message,
    });
  });

  // ---- Start listening -----------------------------------------------------
  await server.listen({ port, host: '0.0.0.0' });
}

/**
 * stopServer — Drain connections and shut down the Fastify server.
 *
 * Called during graceful shutdown. Fastify's close() waits for all in-flight
 * requests to complete before resolving.
 */
export async function stopServer(): Promise<void> {
  if (server) {
    await server.close();
    server = null;
    console.log('[server] HTTP server stopped.');
  }
}
