/**
 * src/monitoring/anomaly.ts — Anomaly detection
 *
 * Defines checks that run every 15 minutes. Each check returns either null
 * (no anomaly) or an AnomalyEvent describing what was detected and how
 * urgently the agent should respond.
 *
 * Design principles:
 *   - Not every anomaly triggers an LLM call. LLM calls cost money; the
 *     anomaly system is the gate that decides whether a situation is worth
 *     the inference budget.
 *   - Each event has a `priority` (low/medium/high/critical) and a
 *     `requiresImmediateAction` flag. The scheduler uses these to decide
 *     whether to trigger a reasoning session immediately or defer to the
 *     next board meeting.
 *   - Checks are deterministic TypeScript. The LLM is never called inside
 *     this module — only in the response handlers.
 */

import axios from 'axios';
import { getRollingMetrics } from './metrics';
import { getLatestEnergyData } from '../intelligence/energy';
import { getPendingExperiments } from '../db/queries/experiments';
import { getAgentTrxBalance } from '../wallet/tronGasfree';
import { getDepositedBalance } from '../wallet/aave';
import { getUsdtBalance, getUsdcBalance, getEthBalance } from '../wallet/evm';
import { getEscrowBalance } from '../wallet/akash';
import { db } from '../db/index';

export type AnomalyPriority = 'low' | 'medium' | 'high' | 'critical';

export type AnomalyType =
  | 'balance_low'
  | 'experiments_due'
  | 'revenue_anomaly'
  | 'energy_price_spike'
  | 'pricing_out_of_market'
  | 'trx_reserve_low'
  | 'inference_balance_low'
  | 'arb_eth_low'
  | 'akash_escrow_low';

export interface AnomalyEvent {
  type: AnomalyType;
  priority: AnomalyPriority;
  /** If true, the scheduler should trigger a decision session immediately. */
  requiresImmediateAction: boolean;
  /** Structured data to pass to the agent as context. */
  data: Record<string, unknown>;
  /** Human-readable description for logging. */
  description: string;
  detectedAt: string;
}

// ---------------------------------------------------------------------------
// Main check function
// ---------------------------------------------------------------------------

/**
 * checkAll — Run all anomaly checks and return a prioritised list of events.
 *
 * Called every 15 minutes by the scheduler. The returned list is sorted by
 * priority (critical first). The scheduler decides which events to act on
 * based on the current cognitive budget.
 *
 * Returns an empty array when everything is normal.
 */
export async function checkAll(): Promise<AnomalyEvent[]> {
  const events: (AnomalyEvent | null)[] = await Promise.all([
    checkBalanceLow(),
    checkTrxReserveLow(),
    checkInferenceBalanceLow(),
    checkArbitrumEthLow(),
    checkAkashEscrowLow(),
    checkExperimentsDue(),
    checkRevenueAnomaly(),
    checkEnergyPriceSpike(),
    // Pricing check runs weekly — the check function gates itself internally.
    checkPricingOutOfMarket(),
  ]);

  // Filter nulls and sort by priority.
  const priorityOrder: Record<AnomalyPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return events
    .filter((e): e is AnomalyEvent => e !== null)
    .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * checkBalanceLow — Warn if liquid USDT is below the minimum float threshold.
 *
 * Minimum float = AAVE_MIN_FLOAT_DAYS × avg_daily_volume.
 * If liquid balance is below this, the agent may need to withdraw from Aave
 * or reduce Aave deposits.
 */
async function checkBalanceLow(): Promise<AnomalyEvent | null> {
  const minFloatDays = parseInt(process.env.AAVE_MIN_FLOAT_DAYS ?? '2', 10);
  const metrics = getRollingMetrics(7);
  // avgRevenuePerTx ≈ totalRevenue / totalTxns — revenue is ~0.3% of forwarded volume,
  // so estimated forwarded volume per tx = revenue_per_tx / (fee_percent / 100).
  const feePercent = parseFloat(process.env.RELAY_FEE_PERCENT ?? '0.3') / 100;
  const avgRevenuePerTx =
    metrics.totalTransactions > 0
      ? (metrics.totalRevenueUsdt + metrics.totalRevenueUsdc) / metrics.totalTransactions
      : 100; // conservative $100/tx default before any data
  const avgTxVolumeUsdt = feePercent > 0 ? avgRevenuePerTx / feePercent : 100;
  const avgDailyVolume = metrics.avgDailyTransactions * avgTxVolumeUsdt;
  const minFloat = minFloatDays * avgDailyVolume;
  const liquidUsdt = parseFloat(await getUsdtBalance('arbitrum'));
  const aaveBalance = parseFloat(await getDepositedBalance());

  if (liquidUsdt < minFloat) {
    const severity: AnomalyPriority = liquidUsdt < minFloat * 0.5 ? 'critical' : 'high';
    return {
      type: 'balance_low',
      priority: severity,
      requiresImmediateAction: severity === 'critical',
      data: { liquidUsdt, aaveBalance, minFloat, minFloatDays },
      description: `Liquid USDT (${liquidUsdt.toFixed(2)}) is below minimum float (${minFloat.toFixed(2)}).`,
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * checkTrxReserveLow — Warn if the TRX reserve for energy sponsorship is low.
 *
 * The reserve covers sponsoring N future transactions. If it drops below
 * 100 transactions' worth of sponsorship, alert for top-up.
 */
async function checkTrxReserveLow(): Promise<AnomalyEvent | null> {
  const trxBalance = parseFloat(await getAgentTrxBalance());
  // Use real energy cost from the intelligence service if available.
  const energyForTrx = getLatestEnergyData();
  const trxPerTransaction = energyForTrx
    ? Math.min(energyForTrx.burnCostTrx, energyForTrx.tronsaveCostTrx)
    : 0.05;
  const transactionsCovered = Math.floor(trxBalance / trxPerTransaction);

  if (transactionsCovered < 100) {
    return {
      type: 'trx_reserve_low',
      priority: transactionsCovered < 20 ? 'critical' : 'high',
      requiresImmediateAction: transactionsCovered < 20,
      data: { trxBalance, transactionsCovered },
      description: `TRX reserve covers only ${transactionsCovered} future sponsorships.`,
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * checkInferenceBalanceLow — Warn if the Base USDC balance is too low to fund inference.
 *
 * The agent pays for AI inference via x402 USDC micropayments on Base (ClawRouter).
 * Each session costs ~$0.03–$0.10. If the balance drops too low, inference stops
 * and the agent can no longer run board meetings or respond to anomalies.
 *
 * Thresholds:
 *   < $0.10 → critical (fewer than ~1–3 sessions remaining)
 *   < $1.00 → high    (fewer than ~10–30 sessions remaining)
 */
async function checkInferenceBalanceLow(): Promise<AnomalyEvent | null> {
  let usdcBalance: number;
  try {
    const raw = await getUsdcBalance('base');
    usdcBalance = parseFloat(raw);
  } catch {
    return null; // Base RPC unavailable — don't false-alarm
  }

  const CRITICAL_THRESHOLD = 0.10;
  const HIGH_THRESHOLD = 1.00;

  if (usdcBalance < CRITICAL_THRESHOLD) {
    return {
      type: 'inference_balance_low',
      priority: 'critical',
      requiresImmediateAction: true,
      data: { usdcBalanceBase: usdcBalance, criticalThreshold: CRITICAL_THRESHOLD },
      description: `Base USDC balance ($${usdcBalance.toFixed(4)}) is critically low — inference may stop imminently.`,
      detectedAt: new Date().toISOString(),
    };
  }

  if (usdcBalance < HIGH_THRESHOLD) {
    return {
      type: 'inference_balance_low',
      priority: 'high',
      requiresImmediateAction: false,
      data: { usdcBalanceBase: usdcBalance, highThreshold: HIGH_THRESHOLD },
      description: `Base USDC balance ($${usdcBalance.toFixed(4)}) is low — fewer than ~${Math.floor(usdcBalance / 0.05)} inference sessions remain.`,
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * checkExperimentsDue — Surface experiments whose evaluation date has passed.
 *
 * This is a scheduled task — experiments don't need urgent action, but they
 * should be evaluated within a day of their check_date to keep the feedback
 * loop tight.
 */
async function checkExperimentsDue(): Promise<AnomalyEvent | null> {
  const pending = getPendingExperiments();
  if (pending.length === 0) return null;

  return {
    type: 'experiments_due',
    priority: 'medium',
    requiresImmediateAction: false,
    data: {
      count: pending.length,
      experiments: pending.map((e) => ({
        id: e.id,
        hypothesis: e.hypothesis,
        checkDate: e.check_date,
        metric: e.metric,
      })),
    },
    description: `${pending.length} experiment(s) are ready for evaluation.`,
    detectedAt: new Date().toISOString(),
  };
}

/**
 * checkRevenueAnomaly — Alert if revenue is significantly above or below average.
 *
 * "Significant" is defined as ±50% vs the 7-day rolling average.
 * Both directions are interesting:
 *   - Sharp drop: could indicate a bug, outage, or competitor pressure.
 *   - Sharp spike: marketing success? Fee too low — opportunity to raise it?
 */
async function checkRevenueAnomaly(): Promise<AnomalyEvent | null> {
  const metrics7d = getRollingMetrics(7);
  const metrics1d = getRollingMetrics(1);

  if (metrics7d.totalTransactions < 10) {
    // Too little historical data to detect anomalies reliably.
    return null;
  }

  const avgDailyRevenue = metrics7d.totalRevenueUsdt / 7;
  const todayRevenue = metrics1d.totalRevenueUsdt;
  const ratio = avgDailyRevenue > 0 ? todayRevenue / avgDailyRevenue : 0;

  if (ratio < 0.5 || ratio > 2.0) {
    return {
      type: 'revenue_anomaly',
      priority: 'medium',
      requiresImmediateAction: false,
      data: {
        todayRevenue,
        avgDailyRevenue,
        ratioVsAverage: ratio,
        direction: ratio < 1 ? 'down' : 'up',
      },
      description: `Today's revenue (${todayRevenue.toFixed(2)} USDT) is ${Math.abs((ratio - 1) * 100).toFixed(0)}% ${ratio < 1 ? 'below' : 'above'} the 7-day average.`,
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * checkEnergyPriceSpike — Alert if TRON energy cost has jumped significantly.
 *
 * A large spike in energy costs may erode the relay's margin on gasless
 * payments. The agent may need to adjust the sponsorship estimate baked into
 * amount_due, or switch providers.
 */
async function checkEnergyPriceSpike(): Promise<AnomalyEvent | null> {
  const energy = getLatestEnergyData();
  if (!energy) return null;

  // Compare current burn cost to the 7-day rolling average from energy_history.
  // A spike is defined as > 1.5× the rolling average (or > 3.5 TRX with no history).
  const FALLBACK_SPIKE_THRESHOLD_TRX = 3.5;
  const SPIKE_MULTIPLIER = 1.5;

  let spikeThreshold = FALLBACK_SPIKE_THRESHOLD_TRX;
  try {
    const row = db
      .prepare(
        `SELECT AVG(CAST(burn_cost_trx AS REAL)) AS avg_burn
         FROM energy_history
         WHERE recorded_at >= datetime('now', '-7 days')`,
      )
      .get() as { avg_burn: number | null } | undefined;
    if (row?.avg_burn && row.avg_burn > 0) {
      spikeThreshold = row.avg_burn * SPIKE_MULTIPLIER;
    }
  } catch {
    // DB may not have the table yet — use the fallback.
  }

  if (energy.burnCostTrx > spikeThreshold) {
    return {
      type: 'energy_price_spike',
      priority: 'medium',
      requiresImmediateAction: false,
      data: {
        burnCostTrx: energy.burnCostTrx,
        threshold: spikeThreshold,
        recommendedProvider: energy.recommendedProvider,
      },
      description: `TRON energy burn cost (${energy.burnCostTrx} TRX) exceeds alert threshold.`,
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * checkArbitrumEthLow — Warn if the agent's Arbitrum ETH gas buffer is running low.
 *
 * The agent needs ETH on Arbitrum to pay gas for Aave deposit/withdraw transactions.
 * If ETH runs out, Aave operations fail silently. The agent should top up by swapping
 * a small amount of USDT → ETH via Uniswap v3 (swap_usdt_to_eth_arb tool).
 *
 * Thresholds:
 *   < 0.001 ETH → critical  (~0–5 Aave txs remaining at typical gas)
 *   < 0.005 ETH → high      (~5–25 Aave txs remaining)
 */
async function checkArbitrumEthLow(): Promise<AnomalyEvent | null> {
  let ethBalance: number;
  try {
    ethBalance = parseFloat(await getEthBalance('arbitrum'));
  } catch {
    return null; // Arbitrum RPC unavailable — don't false-alarm
  }

  const CRITICAL = 0.001;
  const HIGH     = 0.005;

  if (ethBalance < CRITICAL) {
    return {
      type: 'arb_eth_low',
      priority: 'critical',
      requiresImmediateAction: true,
      data: { ethBalanceArbitrum: ethBalance, criticalThreshold: CRITICAL },
      description: `Arbitrum ETH balance (${ethBalance.toFixed(5)} ETH) is critically low — Aave operations may fail.`,
      detectedAt: new Date().toISOString(),
    };
  }

  if (ethBalance < HIGH) {
    return {
      type: 'arb_eth_low',
      priority: 'high',
      requiresImmediateAction: false,
      data: { ethBalanceArbitrum: ethBalance, highThreshold: HIGH },
      description: `Arbitrum ETH balance (${ethBalance.toFixed(5)} ETH) is low — consider swapping USDT → ETH soon.`,
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * checkPricingOutOfMarket — Compare relay fee to competitors (weekly).
 *
 * Gates itself to run only on Mondays. Returns null on all other days.
 *
 * Competitor data sources (in order of preference):
 *   1. NOWPayments public API — largest USDT payment processor, publishes fees
 *   2. Static fallback list — manually-maintained known rates
 *
 * An anomaly is raised when:
 *   - Our fee is > 20% above the cheapest competitor (pricing_high), OR
 *   - Our fee is > 30% below the cheapest competitor (pricing_low —
 *     we're leaving money on the table)
 */
async function checkPricingOutOfMarket(): Promise<AnomalyEvent | null> {
  const dayOfWeek = new Date().getDay(); // 0=Sunday, 1=Monday
  if (dayOfWeek !== 1) return null; // Only run on Mondays.

  // Static fallback: known TRON USDT relay/payment processor fees (%).
  // Updated manually when competitor pricing changes significantly.
  const staticCompetitors: { name: string; feePercent: number }[] = [
    { name: 'NOWPayments (static)', feePercent: 0.5 },
    { name: 'ChangeNOW',            feePercent: 0.5 },
    { name: 'CoinPayments',         feePercent: 0.5 },
  ];

  let competitors = staticCompetitors;

  // Attempt to fetch live NOWPayments fees from their public API.
  try {
    const res = await axios.get('https://api.nowpayments.io/v1/fee', {
      params: { currency_from: 'usdttrc20', currency_to: 'usdttrc20' },
      timeout: 5000,
    });
    // NOWPayments returns { currency_from, currency_to, fee_percent, min_amount }
    const feePercent = parseFloat(res.data?.fee_percent);
    if (!isNaN(feePercent) && feePercent > 0) {
      competitors = [
        { name: 'NOWPayments (live)', feePercent },
        ...staticCompetitors.filter((c) => c.name !== 'NOWPayments (static)'),
      ];
    }
  } catch {
    // Network error or API change — use static fallback silently.
  }

  const ownFee = parseFloat(process.env.RELAY_FEE_PERCENT ?? '0.3');
  const cheapest = Math.min(...competitors.map((c) => c.feePercent));
  const cheapestCompetitor = competitors.find((c) => c.feePercent === cheapest)!;

  const HIGH_THRESHOLD = 1.20; // 20% above cheapest = pricing_high
  const LOW_THRESHOLD  = 0.70; // 30% below cheapest = pricing_low

  const ratio = ownFee / cheapest;

  if (ratio > HIGH_THRESHOLD || ratio < LOW_THRESHOLD) {
    const direction = ratio > HIGH_THRESHOLD ? 'above' : 'below';
    return {
      type: 'pricing_out_of_market',
      priority: 'low',
      requiresImmediateAction: false,
      data: {
        ownFeePercent: ownFee,
        cheapestCompetitor: cheapestCompetitor.name,
        cheapestFeePercent: cheapest,
        ratioVsCheapest: ratio,
        direction,
        competitors,
      },
      description: `Relay fee (${ownFee}%) is ${Math.abs((ratio - 1) * 100).toFixed(0)}% ${direction} cheapest competitor ${cheapestCompetitor.name} (${cheapest}%).`,
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * checkAkashEscrowLow — Warn if the Akash deployment escrow is nearly depleted.
 *
 * If escrow drains to zero, Akash terminates the deployment and the relay goes
 * offline. The agent should top up before this happens.
 *
 * This check is a no-op if AKASH_DEPLOYMENT_DSEQ is not set (e.g., before
 * the first Akash deployment, or when running locally).
 *
 * Thresholds (estimated months remaining):
 *   < 0.5 months (~2 weeks) → critical
 *   < 1.5 months (~6 weeks) → high
 */
async function checkAkashEscrowLow(): Promise<AnomalyEvent | null> {
  const dseq = process.env.AKASH_DEPLOYMENT_DSEQ;
  if (!dseq) return null; // Not deployed on Akash yet.

  let escrow: Awaited<ReturnType<typeof getEscrowBalance>>;
  try {
    escrow = await getEscrowBalance(dseq);
  } catch {
    return null; // Akash REST unavailable — don't false-alarm.
  }

  if (escrow.estimatedMonthsRemaining === null) return null; // No active lease.

  const months = escrow.estimatedMonthsRemaining;

  if (months < 0.5) {
    return {
      type: 'akash_escrow_low',
      priority: 'critical',
      requiresImmediateAction: true,
      data: {
        dseq,
        balanceAkt: escrow.balanceAkt,
        drainRateUaktPerBlock: escrow.drainRateUaktPerBlock,
        monthlyBurnAkt: escrow.monthlyBurnAkt,
        estimatedMonthsRemaining: months,
      },
      description: `Akash escrow critically low: ${escrow.balanceAkt} AKT remaining (~${months.toFixed(2)} months). Deployment will be terminated if not topped up.`,
      detectedAt: new Date().toISOString(),
    };
  }

  if (months < 1.5) {
    return {
      type: 'akash_escrow_low',
      priority: 'high',
      requiresImmediateAction: false,
      data: {
        dseq,
        balanceAkt: escrow.balanceAkt,
        drainRateUaktPerBlock: escrow.drainRateUaktPerBlock,
        monthlyBurnAkt: escrow.monthlyBurnAkt,
        estimatedMonthsRemaining: months,
      },
      description: `Akash escrow running low: ${escrow.balanceAkt} AKT remaining (~${months.toFixed(1)} months). Consider topping up.`,
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}
