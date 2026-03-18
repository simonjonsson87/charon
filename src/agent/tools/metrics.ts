/**
 * src/agent/tools/metrics.ts — Agent tool: get_metrics, get_runway
 *
 * These functions are registered as callable tools in the relay-ops skill
 * (agent/skills/relay-ops/). When the agent calls `get_metrics`, OpenClaw
 * routes the call to getMetrics() here.
 *
 * The functions are thin wrappers that format data for LLM consumption.
 * The underlying data comes from the monitoring/metrics module.
 *
 * Note on formatting:
 *   LLMs consume text more reliably than raw JSON for financial data.
 *   These functions return structured objects, but callers should consider
 *   serialising them with clear field names and units in the prompt context.
 */

import { getRollingMetrics, getDailyMetrics } from '../../monitoring/metrics';
import { getDepositedBalance, getCurrentApy } from '../../wallet/aave';
import { getUsdcBalance, getUsdtBalance } from '../../wallet/evm';
import { getAgentTrxBalance } from '../../wallet/tronGasfree';

export interface MetricsSummary {
  period: string;
  totalRevenueUsdt: number;
  totalRevenueUsdc: number;
  totalTransactions: number;
  avgDailyTransactions: number;
  avgConfirmationSeconds: number;
  llmCalls: number;
  llmCostUsd: number;
  aaveYieldUsdt: number;
  netRevenueUsd: number; // revenue - llm costs
}

/**
 * getMetrics — Return rolling metrics formatted for agent consumption.
 *
 * Called by the agent as the `get_metrics` tool. The `days` parameter
 * is passed by the agent based on what time window it needs.
 * Returns a structured summary with a plain-language description.
 */
export async function getMetrics(days: number): Promise<MetricsSummary> {
  const raw = getRollingMetrics(days);

  const netRevenue =
    raw.totalRevenueUsdt + raw.totalRevenueUsdc + raw.totalAaveYieldUsdt - raw.totalLlmCostUsd;

  return {
    period: `Last ${days} days`,
    totalRevenueUsdt: Math.round(raw.totalRevenueUsdt * 100) / 100,
    totalRevenueUsdc: Math.round(raw.totalRevenueUsdc * 100) / 100,
    totalTransactions: raw.totalTransactions,
    avgDailyTransactions: Math.round(raw.avgDailyTransactions * 10) / 10,
    avgConfirmationSeconds: Math.round(raw.avgConfirmationSeconds),
    llmCalls: raw.totalLlmCalls,
    llmCostUsd: Math.round(raw.totalLlmCostUsd * 1000) / 1000,
    aaveYieldUsdt: Math.round(raw.totalAaveYieldUsdt * 100) / 100,
    netRevenueUsd: Math.round(netRevenue * 100) / 100,
  };
}

/**
 * getDailyBreakdown — Fetch metrics for a specific calendar date.
 *
 * Useful for the agent to compare today vs. a specific historical date.
 * Returns null if no data exists for that date (e.g., the relay wasn't running).
 */
export async function getDailyBreakdown(date: string): Promise<{
  date: string;
  revenueUsdt: number;
  revenueUsdc: number;
  transactions: number;
  llmCostUsd: number;
  aaveYieldUsdt: number;
  walletBalanceUsdt: number;
} | null> {
  const row = getDailyMetrics(date);
  if (!row) return null;

  return {
    date: row.date,
    revenueUsdt: parseFloat(row.revenue_usdt),
    revenueUsdc: parseFloat(row.revenue_usdc),
    transactions: row.transaction_count,
    llmCostUsd: parseFloat(row.llm_cost_usd),
    aaveYieldUsdt: parseFloat(row.aave_yield_usdt),
    walletBalanceUsdt: parseFloat(row.wallet_balance_usdt),
  };
}

/**
 * getRunway — Calculate operational runway in days.
 *
 * Returns a detailed breakdown of assets vs. costs so the agent can
 * reason about whether capital reallocation is needed.
 *
 * "Runway" = total liquid assets / net daily operating cost.
 * Net daily operating cost = daily expenses - daily revenue.
 *
 * A positive runway means the relay is self-sustaining.
 * A negative daily cost (revenue > expenses) means infinite runway.
 */
export async function getRunway(): Promise<{
  runwayDays: number | 'infinite';
  totalLiquidUsd: number;
  aavePositionUsd: number;
  trxReserveTrx: number;
  dailyRevenueUsd: number;
  dailyExpensesUsd: number;
  netDailyCostUsd: number;
  isProfit: boolean;
  aaveApy: string;
}> {
  const [
    liquidUsdt,
    liquidUsdc,
    aaveBalance,
    trxReserve,
    aaveApy,
    metrics7d,
  ] = await Promise.all([
    getUsdtBalance('arbitrum'),
    getUsdcBalance('base'),
    getDepositedBalance(),
    getAgentTrxBalance(),
    getCurrentApy(),
    Promise.resolve(getRollingMetrics(7)),
  ]);

  const totalLiquidUsd = parseFloat(liquidUsdt) + parseFloat(liquidUsdc);
  const aavePositionUsd = parseFloat(aaveBalance);

  const dailyRevenueUsd =
    metrics7d.totalRevenueUsdt / 7 +
    metrics7d.totalRevenueUsdc / 7 +
    metrics7d.totalAaveYieldUsdt / 7;

  const dailyExpensesUsd = metrics7d.totalLlmCostUsd / 7 + 0.10; // LLM + estimated gas

  const netDailyCostUsd = dailyExpensesUsd - dailyRevenueUsd;
  const isProfit = netDailyCostUsd <= 0;

  let runwayDays: number | 'infinite';
  if (isProfit) {
    runwayDays = 'infinite';
  } else {
    runwayDays = Math.round(totalLiquidUsd / netDailyCostUsd);
  }

  return {
    runwayDays,
    totalLiquidUsd: Math.round(totalLiquidUsd * 100) / 100,
    aavePositionUsd: Math.round(aavePositionUsd * 100) / 100,
    trxReserveTrx: parseFloat(trxReserve),
    dailyRevenueUsd: Math.round(dailyRevenueUsd * 1000) / 1000,
    dailyExpensesUsd: Math.round(dailyExpensesUsd * 1000) / 1000,
    netDailyCostUsd: Math.round(netDailyCostUsd * 1000) / 1000,
    isProfit,
    aaveApy,
  };
}
