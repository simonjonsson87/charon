/**
 * src/server/routes/admin.ts — Admin & debug API
 *
 * Provides a control panel for manual testing, judge demos, and on-VPS
 * debugging without requiring SSH access.
 *
 * Authentication:
 *   Set ADMIN_API_KEY in the environment.
 *   Include the header X-Admin-Key: <key> in every request.
 *   If ADMIN_API_KEY is not set, routes are restricted to localhost only.
 *
 * Route map:
 *   GET  /admin/logs                  → recent activity log (judge-friendly)
 *   GET  /admin/status                → all balances + health snapshot
 *   POST /admin/board-meeting         → trigger a board meeting now
 *   POST /admin/anomaly-check         → run all anomaly checks now
 *   POST /admin/trigger-tool          → call any relay-ops tool directly
 *   POST /admin/trigger-anomaly/:type → simulate an anomaly and run its handler
 */

import fs from 'fs';
import path from 'path';
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { getLogs, dbLog } from '../../db/logger';
import type { LogCategory } from '../../db/logger';
import { checkAll } from '../../monitoring/anomaly';
import { handleAnomaly } from '../../agent/decisionLayer';
import { runBoardMeeting, assembleBoardMeetingContext, buildBoardMeetingPrompt } from '../../agent/boardMeeting';
import type { AnomalyType } from '../../monitoring/anomaly';

const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? '';

export async function adminRoutes(
  fastify: FastifyInstance,
  _options: FastifyPluginOptions,
): Promise<void> {

  // ---- Auth gate -----------------------------------------------------------
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const ip = request.ip;
    const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

    if (ADMIN_API_KEY) {
      // If a key is configured, require it from any IP.
      const provided = request.headers['x-admin-key'];
      if (provided !== ADMIN_API_KEY) {
        reply.status(401).send({ error: 'Invalid or missing X-Admin-Key header.' });
      }
    } else {
      // No key set — allow localhost only (safe for local dev).
      if (!isLocalhost) {
        reply.status(403).send({ error: 'Set ADMIN_API_KEY to enable remote admin access.' });
      }
    }
  });

  // ---- GET /admin/memory ---------------------------------------------------
  /**
   * Returns the current contents of MEMORY.md — the agent's persistent memory.
   * Checks MEMORY_PATH (persistent volume) first, falls back to agent/MEMORY.md.
   */
  fastify.get('/memory', async (_request, reply) => {
    const memoryPath = process.env.MEMORY_PATH
      ?? path.join(process.env.OPENCLAW_AGENT_PATH ?? 'agent', 'MEMORY.md');

    try {
      const content = fs.readFileSync(memoryPath, 'utf8');
      reply.type('text/plain').send(content);
    } catch {
      reply.status(404).send({ error: `MEMORY.md not found at ${memoryPath}` });
    }
  });

  // ---- GET /admin/logs -----------------------------------------------------
  /**
   * Returns recent agent activity log entries, newest first.
   * Query params: category, level, since (ISO), limit (default 100)
   *
   * Great for judge demos — shows the full timeline of what the bot did.
   */
  fastify.get('/logs', async (request) => {
    const { category, level, since, limit } = request.query as {
      category?: string;
      level?: string;
      since?: string;
      limit?: string;
    };
    return getLogs({
      category: category as LogCategory | undefined,
      level: level as 'info' | 'warn' | 'error' | undefined,
      since,
      limit: limit ? parseInt(limit, 10) : 100,
    });
  });

  // ---- GET /admin/status ---------------------------------------------------
  /**
   * Returns a full health snapshot: wallet balances, Aave position, Akash
   * escrow, recent anomalies, and server uptime. Useful for a live demo.
   */
  fastify.get('/status', async () => {
    const context = await assembleBoardMeetingContext();
    const boardMeetingPrompt = buildBoardMeetingPrompt(context);
    return {
      ...context,
      uptime: process.uptime(),
      boardMeetingParcel: {
        agent: 'board-meeting',
        thinking: 'high',
        message: boardMeetingPrompt,
        context,
      },
    };
  });

  // ---- POST /admin/board-meeting -------------------------------------------
  /**
   * Triggers a board meeting agent session immediately (outside the daily cron).
   * Returns the session result including tool calls and cost.
   * Takes 1–3 minutes to complete.
   */
  fastify.post('/board-meeting', async (_request, reply) => {
    dbLog('AGENT', 'info', 'Board meeting manually triggered via /admin/board-meeting');
    reply.status(202).send({ message: 'Board meeting started. Poll /admin/logs?category=AGENT to follow progress.' });

    // Run async so the HTTP response returns immediately.
    setImmediate(async () => {
      try {
        await runBoardMeeting();
      } catch (err) {
        dbLog('AGENT', 'error', 'Manual board meeting failed', { error: String(err) });
      }
    });
  });

  // ---- POST /admin/anomaly-check -------------------------------------------
  /**
   * Runs all anomaly checks immediately and returns what was found.
   * If any anomalies require immediate action, their handlers are fired.
   */
  fastify.post('/anomaly-check', async () => {
    dbLog('ANOMALY', 'info', 'Anomaly check manually triggered via /admin/anomaly-check');
    const anomalies = await checkAll();

    for (const anomaly of anomalies) {
      dbLog('ANOMALY', anomaly.priority === 'critical' ? 'error' : 'warn',
        `Anomaly detected: ${anomaly.type}`, { priority: anomaly.priority, description: anomaly.description });
      if (anomaly.requiresImmediateAction) {
        setImmediate(() => handleAnomaly(anomaly));
      }
    }

    return {
      count: anomalies.length,
      anomalies: anomalies.map((a) => ({
        type: a.type,
        priority: a.priority,
        description: a.description,
        requiresImmediateAction: a.requiresImmediateAction,
      })),
    };
  });

  // ---- POST /admin/trigger-tool --------------------------------------------
  /**
   * Directly call any relay-ops tool as if the agent called it.
   * Body: { "tool": "deposit_to_aave", "input": { "amountUsdt": "1.00" } }
   *
   * Useful for testing individual capabilities without running a full board meeting.
   */
  fastify.post('/trigger-tool', async (request) => {
    const { tool, input } = request.body as { tool: string; input: Record<string, unknown> };

    dbLog('AGENT', 'info', `Tool manually triggered: ${tool}`, { input });

    // Import the internal routes handler and call the equivalent function.
    // We dispatch to the same logic used by the openclaw bridge.
    const result = await dispatchTool(tool, input);
    dbLog('AGENT', 'info', `Tool result: ${tool}`, { result });
    return result;
  });

  // ---- POST /admin/trigger-anomaly/:type -----------------------------------
  /**
   * Simulate a specific anomaly event and run its decision handler.
   * Useful for testing that the handler works end-to-end without waiting for
   * the real condition to occur naturally.
   *
   * Example: POST /admin/trigger-anomaly/arb_eth_low
   */
  fastify.post('/trigger-anomaly/:type', async (request) => {
    const { type } = request.params as { type: AnomalyType };
    const body = request.body as Record<string, unknown> | undefined;

    dbLog('ANOMALY', 'info', `Anomaly handler manually triggered: ${type}`, { simulated: true });

    const fakeAnomaly = {
      type,
      priority: 'high' as const,
      requiresImmediateAction: true,
      data: body ?? {},
      description: `Manually simulated ${type} anomaly`,
      detectedAt: new Date().toISOString(),
    };

    setImmediate(() => handleAnomaly(fakeAnomaly));

    return { message: `Handler for ${type} triggered. Check /admin/logs?category=ANOMALY for results.` };
  });
}

// ---------------------------------------------------------------------------
// Tool dispatcher — mirrors the execute_tool() logic in server.py
// ---------------------------------------------------------------------------

async function dispatchTool(
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  // Use 127.0.0.1 explicitly — on Node 18, 'localhost' resolves to ::1 (IPv6)
  // but Fastify binds to 0.0.0.0 (IPv4), causing ECONNREFUSED.
  const base = `http://127.0.0.1:${process.env.PORT ?? 3000}/internal`;

  const http = await import('axios');
  const ax = http.default;

  switch (tool) {
    case 'get_metrics':
      return (await ax.get(`${base}/metrics`, { params: { days: input.days } })).data;
    case 'get_runway':
      return (await ax.get(`${base}/runway`)).data;
    case 'get_capital_summary':
      return (await ax.get(`${base}/capital`)).data;
    case 'get_bridge_fees':
      return (await ax.get(`${base}/bridge/fees`, { params: { amount: input.referenceAmountUsdt ?? '100' } })).data;
    case 'deposit_to_aave':
      return (await ax.post(`${base}/aave/deposit`, input, { timeout: 60000 })).data;
    case 'withdraw_from_aave':
      return (await ax.post(`${base}/aave/withdraw`, input, { timeout: 60000 })).data;
    case 'deposit_usdc_to_aave':
      return (await ax.post(`${base}/aave/deposit-usdc`, input, { timeout: 60000 })).data;
    case 'withdraw_usdc_from_aave':
      return (await ax.post(`${base}/aave/withdraw-usdc`, input, { timeout: 60000 })).data;
    case 'swap_tron_usdt_for_trx':
      return (await ax.post(`${base}/tron/swap-trx`, input, { timeout: 90000 })).data;
    case 'swap_usdt_to_eth_arb':
      return (await ax.post(`${base}/arb/swap-eth`, input, { timeout: 90000 })).data;
    case 'swap_eth_to_usdt_arb':
      return (await ax.post(`${base}/arb/swap-usdt`, input, { timeout: 90000 })).data;
    case 'swap_usdc_to_eth_base':
      return (await ax.post(`${base}/base/swap-eth`, input, { timeout: 90000 })).data;
    case 'swap_eth_to_usdc_base':
      return (await ax.post(`${base}/base/swap-usdc`, input, { timeout: 90000 })).data;
    case 'swap_tron_trx_for_usdt':
      return (await ax.post(`${base}/tron/swap-usdt`, input, { timeout: 90000 })).data;
    case 'get_eth_balance_arb':
      return (await ax.get(`${base}/eth-balance`)).data;
    case 'bridge_tron_to_arbitrum':
      return (await ax.post(`${base}/bridge/tron-to-arb`, input, { timeout: 30000 })).data;
    case 'bridge_arbitrum_to_tron':
      return (await ax.post(`${base}/bridge/arb-to-tron`, input, { timeout: 60000 })).data;
    case 'get_symbiosis_tx_status':
      return (await ax.get(`${base}/bridge/symbiosis-status/${input.txHash}`)).data;
    case 'bridge_tron_to_base':
      return (await ax.post(`${base}/bridge/tron-to-base`, input, { timeout: 30000 })).data;
    case 'bridge_base_to_arbitrum':
      return (await ax.post(`${base}/bridge/base-to-arb`, input, { timeout: 30000 })).data;
    case 'bridge_arbitrum_usdc_to_base':
      return (await ax.post(`${base}/bridge/arb-usdc-to-base`, input, { timeout: 30000 })).data;
    case 'bridge_arbitrum_eth_to_base':
      return (await ax.post(`${base}/bridge/arb-eth-to-base`, input, { timeout: 30000 })).data;
    case 'get_bridge_order_status':
      return (await ax.get(`${base}/bridge/status/${input.orderId}`)).data;
    case 'bridge_base_usdc_to_akt':
      return (await ax.post(`${base}/bridge/base-usdc-to-akt`, input, { timeout: 120000 })).data;
    case 'get_skip_bridge_status':
      return (await ax.get(`${base}/bridge/skip-status/${input.txHash}`, { params: { chainId: input.chainId ?? '8453' } })).data;
    case 'get_akt_balance':
      return (await ax.get(`${base}/akash/balance`)).data;
    case 'get_akash_escrow_status':
      return (await ax.get(`${base}/akash/escrow/${input.dseq}`)).data;
    case 'topup_akash_escrow':
      return (await ax.post(`${base}/akash/escrow/topup`, input, { timeout: 60000 })).data;
    default:
      return { error: `Unknown tool: ${tool}. See CAPABILITIES.md for the full tool list.` };
  }
}
