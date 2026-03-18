/**
 * src/agent/boardMeeting.ts — Daily strategic planning session
 *
 * The board meeting is the agent's primary self-assessment moment. It runs
 * once per day (default: midnight UTC) via the cron scheduler.
 *
 * What the board meeting is NOT:
 *   - It is not a status report to a human. There is no human reading the output.
 *   - It is not required for the relay to function. If it fails, the relay
 *     continues operating with the last settings.
 *
 * What the board meeting IS:
 *   - The agent reviews its own financial performance, experiment outcomes,
 *     and market conditions, then decides whether to make any adjustments.
 *   - Adjustments are made by calling tools (update_fee, deposit_to_aave, etc.)
 *     during the session. No post-processing is needed — tool calls are the output.
 *   - A narrative summary is written to MEMORY.md for historical context.
 *
 * Context assembled before calling OpenClaw (all deterministic TypeScript):
 *   - Last 24h and 7-day rolling metrics
 *   - All wallet balances (TRON USDT, Base USDC, Arbitrum USDT, Aave position)
 *   - Runway calculation (days of operating costs covered by current balance)
 *   - All pending experiments
 *   - Current energy market data
 *   - Current network timing signal
 *   - A fresh snapshot of competitor pricing (fetched here, not from cache)
 */

import { runAgentSession } from './client';
import { getRollingMetrics } from '../monitoring/metrics';
import { getBalance, getTronWalletAddress } from '../wallet/tron';
import { getUsdcBalance, getUsdtBalance, getEthBalance } from '../wallet/evm';
import { getDepositedBalance, getCurrentApy } from '../wallet/aave';
import { getAgentTrxBalance } from '../wallet/tronGasfree';
import { getAktBalance, getEscrowBalance, type EscrowStatus } from '../wallet/akash';
import { getLatestEnergyData } from '../intelligence/energy';
import { getAllExperiments } from '../db/queries/experiments';
import { getLogs } from '../db/logger';
import { db } from '../db/index';

// ---------------------------------------------------------------------------
// Context assembly types
// ---------------------------------------------------------------------------

interface BalanceSnapshot {
  tronUsdtLiquid: string;
  baseUsdc: string;
  arbitrumUsdtLiquid: string;
  arbitrumEth: string;
  aaveUsdtDeposited: string;
  trxReserve: string;
  aaveApy: string;
  aktBalance: string;
  totalUsdtEquivalent: string;
}

interface OperationalStats {
  activeDevelopers: number;
  addressPoolTotal: number;
  addressPoolInUse: number;
  last7dSuccessRate: number; // 0-1
  last30dSuccessRate: number; // 0-1
}

interface RunwayData {
  dailyOperatingCostUsd: number;
  liquidUsd: number;
  runwayDays: number;
}

// ---------------------------------------------------------------------------
// Main board meeting function
// ---------------------------------------------------------------------------

/**
 * runBoardMeeting — Assemble context and trigger an OpenClaw board meeting session.
 *
 * This function is intentionally "thin" — it just collects data and passes it
 * to the agent. All decisions are made by the agent inside OpenClaw.
 */
export async function runBoardMeeting(): Promise<void> {
  console.log('[board-meeting] Assembling context...');

  const [
    metrics24h,
    metrics7d,
    metrics30d,
    balances,
    pendingExperiments,
    allExperiments,
    energyData,
    operationalStats,
    competitorPricing,
  ] = await Promise.all([
    Promise.resolve(getRollingMetrics(1)),
    Promise.resolve(getRollingMetrics(7)),
    Promise.resolve(getRollingMetrics(30)),
    assembleBalanceSnapshot(),
    Promise.resolve(getAllExperiments('pending')),
    Promise.resolve(getAllExperiments()),
    Promise.resolve(getLatestEnergyData()),
    assembleOperationalStats(),
    fetchCompetitorPricing(),
  ]);

  const runway = calculateRunway(balances, metrics7d.totalLlmCostUsd / 7);

  // Akash escrow status (optional — only if deployment is configured).
  let akashStatus: EscrowStatus | null = null;
  const dseq = process.env.AKASH_DEPLOYMENT_DSEQ;
  if (dseq) {
    akashStatus = await getEscrowBalance(dseq).catch(() => null);
  }

  // Recent anomaly log entries (last 24 hours) for the agent's awareness.
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentAnomalies = getLogs({ category: 'ANOMALY', since: since24h, limit: 20 });

  const context = {
    timestamp: new Date().toISOString(),
    metrics: {
      last24h: metrics24h,
      last7d: metrics7d,
      last30d: metrics30d,
    },
    balances,
    runway,
    currentRelayFeePercent: parseFloat(process.env.RELAY_FEE_PERCENT ?? '0.3'),
    competitorPricing,
    akashHosting: akashStatus,
    operationalStats,
    recentAnomalies: recentAnomalies.map((l) => ({
      level: l.level,
      message: l.message,
      data: l.data ? JSON.parse(l.data) : null,
      at: l.created_at,
    })),
    pendingExperiments: pendingExperiments.map((e) => ({
      id: e.id,
      hypothesis: e.hypothesis,
      decision: e.decision,
      metric: e.metric,
      checkDate: e.check_date,
    })),
    experimentHistory: allExperiments.slice(-10),
    energyMarket: energyData
      ? {
          recommendedProvider: energyData.recommendedProvider,
          burnCostTrx: energyData.burnCostTrx,
          savingsPercent: energyData.savingsPercent,
        }
      : null,
  };

  console.log('[board-meeting] Context assembled. Starting agent session...');
  console.log('[board-meeting] Context parcel:\n' + JSON.stringify(context, null, 2));

  const boardMeetingMessage = buildBoardMeetingPrompt(context);

  await runAgentSession({
    message: boardMeetingMessage,
    agent: 'board-meeting',
    sessionId: `board-meeting-${new Date().toISOString().replace(':', '-').split('.')[0]}`,
    thinking: 'high',
    context,
  });

  console.log('[board-meeting] Session complete.');
}

// ---------------------------------------------------------------------------
// Context assembly helpers
// ---------------------------------------------------------------------------

async function assembleBalanceSnapshot(): Promise<BalanceSnapshot> {
  const agentTronAddress = await getTronWalletAddress(0);

  const [
    tronUsdtLiquid,
    baseUsdc,
    arbitrumUsdtLiquid,
    arbitrumEth,
    aaveUsdtDeposited,
    trxReserve,
    aaveApy,
    aktBalance,
  ] = await Promise.all([
    getBalance(agentTronAddress),
    getUsdcBalance('base'),
    getUsdtBalance('arbitrum'),
    getEthBalance('arbitrum'),
    getDepositedBalance(),
    getAgentTrxBalance(),
    getCurrentApy(),
    getAktBalance().catch(() => '0'),
  ]);

  // Rough total (USDC ≈ USDT, ETH and AKT excluded as operational reserves).
  const total = (
    parseFloat(tronUsdtLiquid) +
    parseFloat(baseUsdc) +
    parseFloat(arbitrumUsdtLiquid) +
    parseFloat(aaveUsdtDeposited)
  ).toFixed(2);

  return {
    tronUsdtLiquid,
    baseUsdc,
    arbitrumUsdtLiquid,
    arbitrumEth,
    aaveUsdtDeposited,
    trxReserve,
    aaveApy,
    aktBalance,
    totalUsdtEquivalent: total,
  };
}

/**
 * assembleOperationalStats — Operational health metrics from the DB.
 *
 * Queries SQLite directly for counts that aren't captured in the daily
 * metrics rollup: developer count, address pool utilization, and payment
 * success rate.
 */
function assembleOperationalStats(): OperationalStats {
  const developerCount = (db.prepare(
    'SELECT COUNT(*) as count FROM developers WHERE is_active = 1',
  ).get() as { count: number }).count;

  const poolStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'in_use' THEN 1 ELSE 0 END) as in_use
    FROM address_pool
  `).get() as { total: number; in_use: number };

  const calcSuccessRate = (days: number): number => {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'forwarded' THEN 1 ELSE 0 END) as succeeded,
        COUNT(*) as total
      FROM payments
      WHERE created_at >= ? AND status IN ('forwarded', 'failed', 'expired')
    `).get(cutoff) as { succeeded: number; total: number };
    return row.total > 0 ? row.succeeded / row.total : 1.0;
  };

  return {
    activeDevelopers: developerCount,
    addressPoolTotal: poolStats.total,
    addressPoolInUse: poolStats.in_use,
    last7dSuccessRate: calcSuccessRate(7),
    last30dSuccessRate: calcSuccessRate(30),
  };
}

/**
 * calculateRunway — How many days can the agent operate at current cost rates?
 *
 * Operating costs = LLM inference + energy sponsorship + network fees.
 * Revenue = relay fees + Aave yield + x402 API fees.
 * Net daily cost = operating_costs - revenue.
 * Runway = total_liquid_assets / net_daily_cost.
 *
 * A runway > 365 days means the agent is self-sustaining. A runway < 30 days
 * is a serious concern that warrants immediate attention.
 */
function calculateRunway(
  balances: BalanceSnapshot,
  dailyLlmCostUsd: number,
): RunwayData {
  // Gas cost estimate: ~2 TRX energy sponsorships/day × $0.003 each + RPC call overhead.
  // Refined by the agent over time through experiment outcomes in MEMORY.md.
  const dailyGasCostUsd = 0.10;
  const dailyOperatingCostUsd = dailyLlmCostUsd + dailyGasCostUsd;
  const liquidUsd = parseFloat(balances.totalUsdtEquivalent);
  const runwayDays = dailyOperatingCostUsd > 0 ? liquidUsd / dailyOperatingCostUsd : Infinity;

  return {
    dailyOperatingCostUsd,
    liquidUsd,
    runwayDays: Math.round(runwayDays),
  };
}

/**
 * fetchCompetitorPricing — Return known competitor USDT relay / payment processor fees.
 *
 * Rates are manually verified and updated here. TRON USDT relay is a niche market;
 * there is no public API that aggregates these rates, so we maintain them as a
 * known-good baseline and update when competitors change their published pricing.
 *
 * Sources (last verified 2026-03-14):
 *   NOWPayments   https://nowpayments.io/payment-tools/crypto-payment-gateway — 0.5%
 *   Plisio        https://plisio.net/pricing — 0.5%
 *   CoinPayments  https://www.coinpayments.net/help-fees — 0.5%
 *   CryptoProcessing https://cryptoprocessing.com/fees — 0.8%
 *   TripleA       https://triple-a.io/pricing — 1.0%
 *
 * Additionally attempts to fetch the NOWPayments live rate from their public
 * pricing page as a real-time sanity check. Falls back to the static list on error.
 */
async function fetchCompetitorPricing(): Promise<
  { name: string; feePercent: number; source: string }[]
> {
  const staticRates = [
    { name: 'NOWPayments',       feePercent: 0.5,  source: 'nowpayments.io' },
    { name: 'Plisio',            feePercent: 0.5,  source: 'plisio.net' },
    { name: 'CoinPayments',      feePercent: 0.5,  source: 'coinpayments.net' },
    { name: 'CryptoProcessing',  feePercent: 0.8,  source: 'cryptoprocessing.com' },
    { name: 'TripleA',           feePercent: 1.0,  source: 'triple-a.io' },
  ];

  // Attempt live rate for NOWPayments (they publish fees via their API).
  // This is best-effort — we don't block the board meeting if it fails.
  try {
    const axios = (await import('axios')).default;
    const res = await axios.get('https://nowpayments.io/api/v1/fees', { timeout: 4000 });
    const tronUsdtFee: number | undefined = res.data?.USDTTRC20?.fee_percent;
    if (typeof tronUsdtFee === 'number') {
      staticRates[0] = { ...staticRates[0], feePercent: tronUsdtFee };
    }
  } catch {
    // Live fetch failed — static value is used as-is.
  }

  return staticRates;
}

/**
 * buildBoardMeetingPrompt — Construct the structured prompt for the board meeting.
 *
 * The prompt tells the agent what it needs to assess. The context object
 * is injected separately by runAgentSession().
 */
function buildBoardMeetingPrompt(context: Record<string, unknown>): string {
  void context; // context is injected as structured JSON alongside this message
  return `
# Daily Board Meeting — ${new Date().toISOString().replace('T', ' ').split('.')[0]} UTC

All data you need is pre-loaded in the context object below this message.
**Do NOT call tools to retrieve data — every tool call costs money. Use tools only to execute decisions.**

## What is already in your context (do NOT re-fetch these)

| context field | do NOT call |
|---|---|
| context.metrics.last24h / last7d / last30d | get_metrics |
| context.balances (all wallets: Tron USDT, Base USDC, Arb USDT+ETH, Aave, TRX, AKT) | get_capital_summary, get_eth_balance_arb, get_akt_balance |
| context.runway | get_runway |
| context.akashHosting (escrow balance + runway, or null) | get_akash_escrow_status |
| context.pendingExperiments + context.experimentHistory | get_experiments |
| context.currentRelayFeePercent | — |
| context.competitorPricing | — |
| context.operationalStats (developer count, pool size, success rate) | — |
| context.recentAnomalies | — |

## Tools to call only for ACTIONS

- **Decisions**: update_fee, deposit_to_aave, withdraw_from_aave, swap_tron_usdt_for_trx, swap_usdt_to_eth_arb, bridge_tron_to_arbitrum, topup_akash_escrow
- **Recording**: save_experiment (before any significant action), evaluate_experiment (for overdue experiments)
- **Memory**: update_memory (once, at the end, with a 2–3 paragraph summary)

## Agenda

1. **Financial review** — use context.metrics to assess 24h and 7d performance.
2. **Experiment evaluation** — check context.pendingExperiments for any past their checkDate. Call evaluate_experiment for those.
3. **Capital allocation** — use context.balances + context.runway. Act if TRX reserve is low, Aave needs rebalancing, or Akash escrow (context.akashHosting) is below 1.5 months.
4. **Pricing** — compare context.currentRelayFeePercent to context.competitorPricing. If adjusting: save_experiment first, then update_fee.
5. **Summary** — call update_memory once with a concise 2–3 paragraph board meeting summary.
`.trim();
}

