/**
 * src/server/routes/internal.ts — Internal API for the OpenClaw bridge
 *
 * These routes are called by openclaw-bridge/server.py when the agent
 * executes relay-ops tool calls. They expose the agent tool functions
 * (metrics, experiments, pricing, capital) over HTTP.
 *
 * Security: bound to localhost-only requests via a preHandler hook.
 * External callers receive 403 Forbidden.
 *
 * Route map (mirrors relay-ops/SKILL.md tool definitions):
 *   GET  /internal/metrics?days=N           → get_metrics
 *   GET  /internal/runway                   → get_runway
 *   GET  /internal/experiments              → get_experiments
 *   POST /internal/experiments              → save_experiment
 *   PATCH /internal/experiments/:id/evaluate → evaluate_experiment
 *   POST /internal/fee                      → update_fee
 *   GET  /internal/capital                  → get_capital_summary
 *   POST /internal/aave/deposit             → deposit_to_aave
 *   POST /internal/aave/withdraw            → withdraw_from_aave
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { getMetrics, getRunway } from '../../agent/tools/metrics';
import {
  getExperiments,
  saveExperiment,
  evaluateExperiment,
} from '../../agent/tools/experiments';
import { updateFee } from '../../agent/tools/pricing';
import {
  getCapitalSummary,
  depositToAave, withdrawFromAave,
  depositUsdcToAave, withdrawUsdcFromAave,
  getBridgeFeesForAgent,
} from '../../agent/tools/capital';
import { swapUsdtForTrx } from '../../wallet/tron';
import { swapUsdtForEth, getEthBalance } from '../../wallet/evm';
import {
  bridgeTronToArbitrum,
  bridgeBaseToArbitrum,
  bridgeArbitrumToTron,
  bridgeArbitrumUsdcToBase,
  bridgeArbitrumEthToBase,
  getBridgeOrderStatus,
  getSymbiosisOrderStatus,
} from '../../wallet/bridge';
import { getAkashAddress, getAktBalance, getEscrowBalance, topUpEscrow } from '../../wallet/akash';
import type { ExperimentStatus } from '../../db/schema';

export async function internalRoutes(
  fastify: FastifyInstance,
  _options: FastifyPluginOptions,
): Promise<void> {
  // Reject requests not originating from localhost.
  // The OpenClaw bridge always calls from 127.0.0.1.
  fastify.addHook('preHandler', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403).send({ error: 'Internal routes are localhost-only.' });
    }
  });

  // ---- Metrics ------------------------------------------------------------

  fastify.get('/metrics', async (request) => {
    const { days } = request.query as { days?: string };
    return getMetrics(parseInt(days ?? '7', 10));
  });

  fastify.get('/runway', async () => {
    return getRunway();
  });

  // ---- Experiments --------------------------------------------------------

  fastify.get('/experiments', async (request) => {
    const { status, limit } = request.query as { status?: string; limit?: string };
    return getExperiments(
      status as ExperimentStatus | undefined,
      limit ? parseInt(limit, 10) : 20,
    );
  });

  fastify.post('/experiments', async (request) => {
    const body = request.body as {
      context: string;
      hypothesis: string;
      decision: string;
      metric: string;
      checkDate: string;
    };
    return saveExperiment(body);
  });

  fastify.patch('/experiments/:id/evaluate', async (request) => {
    const { id } = request.params as { id: string };
    const { outcome, learning } = request.body as { outcome: string; learning: string };
    evaluateExperiment(id, outcome, learning);
    return { ok: true };
  });

  // ---- Pricing ------------------------------------------------------------

  fastify.post('/fee', async (request) => {
    const { newPercent, reason } = request.body as { newPercent: number; reason: string };
    return updateFee(newPercent, reason);
  });

  // ---- Capital ------------------------------------------------------------

  fastify.get('/capital', async () => {
    return getCapitalSummary();
  });

  fastify.get('/bridge/fees', async (request) => {
    const { amount } = request.query as { amount?: string };
    return getBridgeFeesForAgent(amount ?? '100');
  });

  fastify.post('/aave/deposit', async (request) => {
    const { amountUsdt } = request.body as { amountUsdt: string };
    return depositToAave(amountUsdt);
  });

  fastify.post('/aave/withdraw', async (request) => {
    const { amountUsdt } = request.body as { amountUsdt: string };
    return withdrawFromAave(amountUsdt);
  });

  fastify.post('/aave/deposit-usdc', async (request) => {
    const { amountUsdc } = request.body as { amountUsdc: string };
    return depositUsdcToAave(amountUsdc);
  });

  fastify.post('/aave/withdraw-usdc', async (request) => {
    const { amountUsdc } = request.body as { amountUsdc: string };
    return withdrawUsdcFromAave(amountUsdc);
  });

  // ---- Cross-chain operations ---------------------------------------------

  /**
   * POST /internal/tron/swap-trx
   * Swap USDT → TRX on Tron via SunSwap v2 to top up the energy sponsorship reserve.
   * Body: { amountUsdt: string }
   */
  fastify.post('/tron/swap-trx', async (request) => {
    const { amountUsdt } = request.body as { amountUsdt: string };
    const txHash = await swapUsdtForTrx(amountUsdt);
    return { txHash, amountUsdt };
  });

  /**
   * POST /internal/arb/swap-eth
   * Swap USDT → ETH on Arbitrum via Uniswap v3 to top up the gas buffer.
   * Body: { amountUsdt: string }
   */
  fastify.post('/arb/swap-eth', async (request) => {
    const { amountUsdt } = request.body as { amountUsdt: string };
    const txHash = await swapUsdtForEth(amountUsdt);
    return { txHash, amountUsdt };
  });

  /**
   * GET /internal/eth-balance
   * Return the agent's native ETH balance on Arbitrum.
   */
  fastify.get('/eth-balance', async () => {
    const ethBalance = await getEthBalance('arbitrum');
    return { ethBalanceArbitrum: ethBalance };
  });

  /**
   * POST /internal/bridge/tron-to-arb
   * Bridge USDT from Tron to Arbitrum via deBridge DLN.
   * Body: { amountUsdt: string }
   */
  fastify.post('/bridge/tron-to-arb', async (request) => {
    const { amountUsdt } = request.body as { amountUsdt: string };
    const orderId = await bridgeTronToArbitrum(amountUsdt);
    return { orderId, amountUsdt, explorerUrl: `https://app.debridge.finance/order?orderId=${orderId}` };
  });

  fastify.post('/bridge/base-to-arb', async (request) => {
    const { amountUsdc } = request.body as { amountUsdc: string };
    const orderId = await bridgeBaseToArbitrum(amountUsdc);
    return { orderId, amountUsdc, explorerUrl: `https://app.debridge.finance/order?orderId=${orderId}` };
  });

  fastify.post('/bridge/arb-to-tron', async (request) => {
    const { amountUsdt } = request.body as { amountUsdt: string };
    const txHash = await bridgeArbitrumToTron(amountUsdt);
    return { txHash, amountUsdt, explorerUrl: `https://arbiscan.io/tx/${txHash}`, provider: 'symbiosis' };
  });

  fastify.post('/bridge/arb-usdc-to-base', async (request) => {
    const { amountUsdc } = request.body as { amountUsdc: string };
    const orderId = await bridgeArbitrumUsdcToBase(amountUsdc);
    return { orderId, amountUsdc, explorerUrl: `https://app.debridge.finance/order?orderId=${orderId}` };
  });

  fastify.post('/bridge/arb-eth-to-base', async (request) => {
    const { amountEth } = request.body as { amountEth: string };
    const orderId = await bridgeArbitrumEthToBase(amountEth);
    return { orderId, amountEth, explorerUrl: `https://app.debridge.finance/order?orderId=${orderId}` };
  });

  /**
   * GET /internal/bridge/status/:orderId
   * Poll the status of a deBridge DLN order.
   */
  fastify.get('/bridge/status/:orderId', async (request) => {
    const { orderId } = request.params as { orderId: string };
    return getBridgeOrderStatus(orderId);
  });

  /**
   * GET /internal/bridge/symbiosis-status/:txHash
   * Poll the status of a Symbiosis Arbitrum→Tron transfer by Arbitrum tx hash.
   */
  fastify.get('/bridge/symbiosis-status/:txHash', async (request) => {
    const { txHash } = request.params as { txHash: string };
    return getSymbiosisOrderStatus(txHash);
  });

  // ---- Akash hosting -------------------------------------------------------

  /**
   * GET /internal/akash/address
   * Return the agent's Akash wallet address (akash1...).
   */
  fastify.get('/akash/address', async () => {
    const address = await getAkashAddress();
    return { address };
  });

  /**
   * GET /internal/akash/balance
   * Return the agent's AKT wallet balance.
   */
  fastify.get('/akash/balance', async () => {
    const balanceAkt = await getAktBalance();
    return { balanceAkt };
  });

  /**
   * GET /internal/akash/escrow/:dseq
   * Return the escrow status for a deployment: balance, drain rate, runway.
   */
  fastify.get('/akash/escrow/:dseq', async (request) => {
    const { dseq } = request.params as { dseq: string };
    return getEscrowBalance(dseq);
  });

  /**
   * POST /internal/akash/escrow/topup
   * Top up the deployment escrow by broadcasting a MsgDepositDeployment tx.
   * Body: { dseq: string, amountAkt: string }
   */
  fastify.post('/akash/escrow/topup', async (request) => {
    const { dseq, amountAkt } = request.body as { dseq: string; amountAkt: string };
    const txHash = await topUpEscrow(dseq, amountAkt);
    return { txHash, dseq, amountAkt };
  });
}

