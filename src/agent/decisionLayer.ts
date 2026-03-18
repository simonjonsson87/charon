/**
 * src/agent/decisionLayer.ts — Event-triggered focused reasoning
 *
 * While the board meeting is a broad strategic review, decision sessions are
 * narrowly scoped responses to specific anomaly events. Each anomaly type
 * has its own prompt template and thinking configuration.
 *
 * Decision session design principles:
 *   - Provide only the context the agent needs for THIS decision.
 *     Information overload leads to worse decisions.
 *   - Ask for a structured JSON response so the server can parse the outcome.
 *   - Set thinking level appropriate to the decision's stakes:
 *     - 'high' for capital allocation and pricing changes.
 *     - 'low' for routine experiment evaluations.
 *   - Always gracefully handle the case where the agent produces no actionable output.
 *
 * The 'decision' agent in openclaw.json is configured with responseFormat: 'json',
 * which instructs OpenClaw to enforce a JSON response from the model.
 */

import { runAgentSession } from './client';
import type { AnomalyEvent, AnomalyType } from '../monitoring/anomaly';
import { getRollingMetrics } from '../monitoring/metrics';
import { getDepositedBalance, getCurrentApy } from '../wallet/aave';
import { getUsdtBalance } from '../wallet/evm';
import { getAllExperiments, updateExperiment } from '../db/queries/experiments';
import { getAktBalance, getEscrowBalance } from '../wallet/akash';

// ---------------------------------------------------------------------------
// Main dispatch function
// ---------------------------------------------------------------------------

/**
 * handleAnomaly — Route an anomaly to the appropriate decision handler.
 *
 * Each anomaly type has a dedicated handler that:
 *   1. Assembles the relevant context for that specific decision.
 *   2. Calls runAgentSession with a focused prompt.
 *   3. Parses the JSON response and applies any actions.
 */
export async function handleAnomaly(anomaly: AnomalyEvent): Promise<void> {
  const handlers: Record<AnomalyType, (event: AnomalyEvent) => Promise<void>> = {
    balance_low: handleBalanceLow,
    trx_reserve_low: handleTrxReserveLow,
    inference_balance_low: handleInferenceBalanceLow,
    arb_eth_low: handleArbEthLow,
    akash_escrow_low: handleAkashEscrowLow,
    experiments_due: handleExperimentsDue,
    revenue_anomaly: handleRevenueAnomaly,
    energy_price_spike: handleEnergyPriceSpike,
    pricing_out_of_market: handlePricingOutOfMarket,
  };

  const handler = handlers[anomaly.type];
  if (!handler) {
    console.warn(`[decision] No handler for anomaly type: ${anomaly.type}`);
    return;
  }

  await handler(anomaly);
}

// ---------------------------------------------------------------------------
// Individual anomaly handlers
// ---------------------------------------------------------------------------

/**
 * handleBalanceLow — Capital allocation decision.
 *
 * Context: liquid balance, Aave position, min float requirement, APY.
 * Expected agent output: JSON with `action` ('withdraw_aave' | 'no_action'),
 *   `amount` (if withdraw), and `reasoning`.
 * Thinking: high — capital decisions are high-stakes.
 */
async function handleBalanceLow(anomaly: AnomalyEvent): Promise<void> {
  const [aaveBalance, aaveApy, liquidUsdt] = await Promise.all([
    getDepositedBalance(),
    getCurrentApy(),
    getUsdtBalance('arbitrum'),
  ]);

  const context = {
    anomaly: anomaly.data,
    aaveBalance,
    aaveApy,
    liquidUsdt,
    minFloatDays: process.env.AAVE_MIN_FLOAT_DAYS ?? '2',
  };

  const result = await runAgentSession({
    message: buildCapitalAllocationPrompt(context),
    agent: 'decision',
    sessionId: `decision-balance-low-${Date.now()}`,
    thinking: 'high',
    context,
  });

  if (!result.text) return;

  try {
    const decision = JSON.parse(result.text) as {
      action: 'withdraw_aave' | 'no_action';
      amount?: string;
      reasoning: string;
    };

    console.log(`[decision] Capital allocation: action=${decision.action} reason=${decision.reasoning}`);

    if (decision.action === 'withdraw_aave' && decision.amount) {
      const { withdraw } = await import('../wallet/aave');
      await withdraw(decision.amount);
      console.log(`[decision] Withdrew ${decision.amount} USDT from Aave.`);
    }
  } catch {
    console.error(`[decision] Failed to parse capital allocation response: ${result.text.substring(0, 200)}`);
  }
}

/**
 * handleTrxReserveLow — TRX reserve top-up decision.
 *
 * Context: current TRX balance, Tron USDT balance, cost per sponsorship,
 * transaction volume. The agent weighs TRX need against liquid USDT available.
 * If it decides to swap, this handler executes the swap immediately.
 *
 * Note: swapUsdtForTrx itself requires a small amount of TRX for energy.
 * If TRX is truly zero, the swap will fail and the agent should respond with
 * source="manual" in that case.
 */
async function handleTrxReserveLow(anomaly: AnomalyEvent): Promise<void> {
  const metrics = getRollingMetrics(7);

  const { getTronWalletAddress, getBalance: getTronUsdtBalance } = await import('../wallet/tron');
  const tronAddress = await getTronWalletAddress(0);
  const tronUsdtBalance = await getTronUsdtBalance(tronAddress);

  const context = {
    anomaly: anomaly.data,
    metrics,
    tronUsdtBalance,
    trxPriceUsd: 0.30, // rough reference; agent should not over-optimise on this
  };

  const result = await runAgentSession({
    message: `The TRX reserve for energy sponsorship is critically low.

Current state:
- TRX balance: ${(anomaly.data as { trxBalance: number }).trxBalance} TRX
- Transactions currently covered: ${(anomaly.data as { transactionsCovered: number }).transactionsCovered}
- Tron USDT balance available to swap: ${tronUsdtBalance} USDT
- Transaction volume last 7 days: ${metrics.totalTransactions}

Each relay sponsorship costs ~1.8 TRX. We want at least 100 transactions of reserve (180 TRX).

Decide how much USDT to swap for TRX. Consider:
- Do not swap if Tron USDT is too low to leave adequate operating capital.
- A minimum swap of ~2 USDT is needed to cover SunSwap gas (~20-30 TRX output).
- If TRX balance is near zero, the swap tx itself will fail — flag source="manual" in that case.
- Prefer conservative amounts: top up to ~100 sponsorships worth rather than draining USDT.

Respond with JSON: { "action": "swap_usdt" | "no_action", "amount_usdt": number | null, "reasoning": string }`,
    agent: 'decision',
    sessionId: `decision-trx-reserve-${Date.now()}`,
    thinking: 'high',
    context,
  });

  console.log(`[decision] TRX reserve decision: ${result.text?.substring(0, 300)}`);

  if (!result.text) return;

  try {
    const decision = JSON.parse(result.text) as {
      action: 'swap_usdt' | 'no_action';
      amount_usdt: number | null;
      reasoning: string;
    };

    if (decision.action === 'swap_usdt' && decision.amount_usdt && decision.amount_usdt > 0) {
      const { swapUsdtForTrx } = await import('../wallet/tron');
      const amountStr = decision.amount_usdt.toFixed(6);
      console.log(`[decision] Swapping ${amountStr} USDT → TRX on SunSwap. Reason: ${decision.reasoning}`);
      const txHash = await swapUsdtForTrx(amountStr);
      console.log(`[decision] TRX top-up swap complete. TX: ${txHash}`);
    } else {
      console.log(`[decision] TRX top-up: no_action. Reason: ${decision.reasoning}`);
    }
  } catch (err) {
    console.error(`[decision] Failed to parse or execute TRX reserve decision: ${err}`);
  }
}

/**
 * handleExperimentsDue — Evaluate pending experiments.
 *
 * Provides the experiment data and relevant metrics. The agent reads the
 * outcome, writes a learning, and decides if any follow-up action is needed.
 * Thinking: low — this is largely a read-and-record task.
 */
async function handleExperimentsDue(anomaly: AnomalyEvent): Promise<void> {
  const metrics7d = getRollingMetrics(7);
  const allExperiments = getAllExperiments();

  const result = await runAgentSession({
    message: buildExperimentEvaluationPrompt(anomaly.data, metrics7d),
    agent: 'decision',
    sessionId: `decision-experiments-${Date.now()}`,
    thinking: 'low',
    context: { experiments: anomaly.data, metrics: metrics7d, allHistory: allExperiments },
  });

  if (!result.text) return;

  try {
    const evaluations = JSON.parse(result.text) as Array<{
      id: string;
      outcome: string;
      learning: string;
    }>;

    for (const ev of evaluations) {
      updateExperiment(ev.id, ev.outcome, ev.learning);
    }
    console.log(`[decision] Evaluated ${evaluations.length} experiment(s).`);
  } catch {
    console.error(`[decision] Failed to parse experiment evaluation response: ${result.text.substring(0, 200)}`);
  }
}

/**
 * handleRevenueAnomaly — Assess unusual revenue pattern.
 *
 * The agent decides whether the anomaly is signal (worth responding to) or
 * noise (e.g., random daily fluctuation). Low thinking level — this is a
 * diagnostic task, not a high-stakes decision.
 */
async function handleRevenueAnomaly(anomaly: AnomalyEvent): Promise<void> {
  const metrics30d = getRollingMetrics(30);

  await runAgentSession({
    message: buildRevenueAnomalyPrompt(anomaly.data, metrics30d),
    agent: 'decision',
    sessionId: `decision-revenue-${Date.now()}`,
    thinking: 'low',
    context: { anomaly: anomaly.data, metrics30d },
  });
}

/**
 * handleEnergyPriceSpike — Assess TRON energy market disruption.
 *
 * The agent decides whether the current sponsorship estimate baked into
 * amount_due needs updating, or whether the spike is transient.
 */
async function handleEnergyPriceSpike(anomaly: AnomalyEvent): Promise<void> {
  await runAgentSession({
    message: `TRON energy price spike detected. Data: ${JSON.stringify(anomaly.data)}. Should we adjust our sponsorship cost estimate? Respond with JSON: { "action": "update_estimate" | "monitor", "newEstimateTrx": number | null, "reasoning": string }`,
    agent: 'decision',
    sessionId: `decision-energy-spike-${Date.now()}`,
    thinking: 'adaptive',
    context: { anomaly: anomaly.data },
  });
}

/**
 * handleInferenceBalanceLow — Base USDC inference funding is running low.
 *
 * Logs the event for visibility. The agent cannot autonomously top this up
 * (it would require bridging which costs more USDC than it saves). Instead,
 * x402 fees from /payment/create calls refill this automatically over time.
 * If critical, alert that x402 income must be sufficient to cover sessions.
 */
async function handleInferenceBalanceLow(anomaly: AnomalyEvent): Promise<void> {
  console.warn(
    `[decision] Inference balance low: $${(anomaly.data.usdcBalanceBase as number)?.toFixed(4) ?? '?'} USDC on Base. ` +
    `Priority: ${anomaly.priority}. The x402 /payment/create fees should replenish this over time.`,
  );
  // No automated action — inference funds are replenished by x402 API usage.
  // Board meeting will see this in capital summary and can investigate if needed.
}

/**
 * handleArbEthLow — Arbitrum ETH gas buffer is low.
 *
 * Triggers a swap of a small amount of USDT → ETH on Arbitrum via Uniswap v3.
 * This is a fully automated maintenance operation (no experiment needed).
 */
async function handleArbEthLow(anomaly: AnomalyEvent): Promise<void> {
  console.log(`[decision] Arbitrum ETH low (${anomaly.data.ethBalanceArbitrum} ETH). Triggering USDT→ETH swap.`);

  // Swap 3 USDT → ETH on Arbitrum. This covers ~15–60 Aave transactions at typical gas.
  const swapAmount = '3.00';

  try {
    const { swapUsdtForEth } = await import('../wallet/evm');
    const txHash = await swapUsdtForEth(swapAmount);
    console.log(`[decision] ETH top-up complete. TX: ${txHash}`);
  } catch (err) {
    console.error(`[decision] ETH top-up swap failed:`, err);
  }
}

/**
 * handlePricingOutOfMarket — Competitive pricing review.
 *
 * High thinking — pricing decisions affect revenue and competitive position.
 * The agent may decide to raise or lower the fee, or hold steady with a reason.
 */
async function handlePricingOutOfMarket(anomaly: AnomalyEvent): Promise<void> {
  const metrics7d = getRollingMetrics(7);

  await runAgentSession({
    message: buildPricingReviewPrompt(anomaly.data, metrics7d),
    agent: 'decision',
    sessionId: `decision-pricing-${Date.now()}`,
    thinking: 'high',
    context: { anomaly: anomaly.data, metrics7d },
  });
}

/**
 * handleAkashEscrowLow — Top up the Akash deployment escrow.
 *
 * The agent decides how much AKT to deposit based on current drain rate
 * and AKT wallet balance. Target: restore 3 months of runway.
 * Thinking: high — hosting continuity is business-critical.
 */
async function handleAkashEscrowLow(anomaly: AnomalyEvent): Promise<void> {
  const dseq = process.env.AKASH_DEPLOYMENT_DSEQ;
  if (!dseq) {
    console.warn('[decision] akash_escrow_low fired but AKASH_DEPLOYMENT_DSEQ not set — skipping.');
    return;
  }

  const [aktBalance, escrow] = await Promise.all([
    getAktBalance(),
    getEscrowBalance(dseq),
  ]);

  const result = await runAgentSession({
    message: buildAkashEscrowPrompt(anomaly.data, aktBalance, dseq),
    agent: 'decision',
    sessionId: `decision-akash-escrow-${Date.now()}`,
    thinking: 'high',
    context: { anomaly: anomaly.data, aktBalance, escrow },
  });

  if (!result.text) return;

  try {
    const decision = JSON.parse(result.text) as {
      action: 'topup_escrow' | 'no_action';
      amountAkt?: string;
      reasoning: string;
    };

    console.log(`[decision] Akash escrow: action=${decision.action} reason=${decision.reasoning}`);

    if (decision.action === 'topup_escrow' && decision.amountAkt) {
      const { topUpEscrow } = await import('../wallet/akash');
      const txHash = await topUpEscrow(dseq, decision.amountAkt);
      console.log(`[decision] Akash escrow topped up: +${decision.amountAkt} AKT tx=${txHash}`);
    }
  } catch {
    console.error(`[decision] Failed to parse Akash escrow response: ${result.text.substring(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildCapitalAllocationPrompt(context: Record<string, unknown>): string {
  return `
Capital allocation decision needed.

Context: ${JSON.stringify(context, null, 2)}

The minimum float requirement is ${context.minFloatDays} days of average transaction volume.
Current liquid USDT is below this threshold.

Options:
1. Withdraw some USDT from Aave to restore the float.
2. Take no action if the shortfall is minor and Aave yield is worth the small risk.

Respond with JSON: {
  "action": "withdraw_aave" | "no_action",
  "amount": "decimal string or null",
  "reasoning": "brief explanation"
}
`.trim();
}

function buildExperimentEvaluationPrompt(
  experimentData: Record<string, unknown>,
  metrics: ReturnType<typeof getRollingMetrics>,
): string {
  return `
Experiments are ready for evaluation.

Pending experiments: ${JSON.stringify(experimentData, null, 2)}
Current 7-day metrics: ${JSON.stringify(metrics, null, 2)}

For each experiment, evaluate whether the hypothesis was supported by the metrics.
Record your outcome and learning.

Respond with JSON array: [{
  "id": "experiment id",
  "outcome": "what actually happened",
  "learning": "what this tells us about the business"
}]
`.trim();
}

function buildRevenueAnomalyPrompt(
  anomalyData: Record<string, unknown>,
  metrics30d: ReturnType<typeof getRollingMetrics>,
): string {
  return `
Revenue anomaly detected.

Anomaly data: ${JSON.stringify(anomalyData, null, 2)}
30-day metrics context: ${JSON.stringify(metrics30d, null, 2)}

Is this anomaly signal or noise? If signal, is a response warranted?

Respond with JSON: {
  "isSignal": boolean,
  "diagnosis": "brief explanation",
  "action": "create_experiment" | "no_action" | "urgent_review",
  "reasoning": "explanation"
}
`.trim();
}

function buildAkashEscrowPrompt(
  anomalyData: Record<string, unknown>,
  aktBalance: string,
  dseq: string,
): string {
  return `
Akash deployment escrow is running low and needs to be topped up.

Anomaly data: ${JSON.stringify(anomalyData, null, 2)}
Current AKT wallet balance: ${aktBalance} AKT
Deployment dseq: ${dseq}

The relay runs on Akash. If escrow runs to zero, Akash terminates the deployment
and the relay goes offline. This is the highest-priority operational risk.

Target: top up to 3 months of runway (3× the monthly burn rate).
Monthly burn = drainRateUaktPerBlock × 370,000 / 1,000,000 AKT.

Constraints:
- Never top up more than 90% of the current AKT wallet balance.
- Minimum useful top-up: 2 AKT (less is not worth the transaction fee).
- If AKT balance is < 2 AKT, take no_action and log that manual funding is required.

Respond with JSON: {
  "action": "topup_escrow" | "no_action",
  "amountAkt": "decimal string or null",
  "reasoning": "brief explanation"
}
`.trim();
}

function buildPricingReviewPrompt(
  anomalyData: Record<string, unknown>,
  metrics7d: ReturnType<typeof getRollingMetrics>,
): string {
  return `
Weekly competitive pricing review.

Market data: ${JSON.stringify(anomalyData, null, 2)}
Our 7-day metrics: ${JSON.stringify(metrics7d, null, 2)}
Current relay fee: ${process.env.RELAY_FEE_PERCENT ?? '0.3'}%

Review our pricing position. Should we adjust?
Remember: always create an experiment before changing the fee.

Respond with JSON: {
  "currentPositioning": "below_market" | "at_market" | "above_market",
  "action": "raise_fee" | "lower_fee" | "hold",
  "proposedFeePercent": number | null,
  "reasoning": "explanation",
  "createExperiment": boolean
}
`.trim();
}
