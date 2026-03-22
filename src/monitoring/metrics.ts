/**
 * src/monitoring/metrics.ts — Metrics collection and rollup
 *
 * Tracks the relay's financial and operational performance over time.
 * All metrics are persisted to the metrics_daily table in SQLite.
 *
 * The metrics serve two purposes:
 *   1. Operational monitoring — is the relay working correctly?
 *   2. Agent context — the board meeting agent reads rolling metrics to
 *      assess performance and decide on pricing/capital allocation changes.
 *
 * Architecture note:
 *   Metrics are accumulated in-memory during the day and written to DB
 *   by rollupDailyMetrics() at 23:55. For a high-availability deployment,
 *   write directly to DB on each event (no in-memory accumulation) to
 *   survive process restarts.
 */

import { db } from '../db/index';
import type { MetricsDaily } from '../db/schema';
import { getSetting, setSetting, SETTING_KEYS } from '../db/queries/settings';

// ---------------------------------------------------------------------------
// In-memory daily accumulators
// ---------------------------------------------------------------------------

interface DailyAccumulator {
  date: string; // YYYY-MM-DD
  revenueUsdc: number;
  revenueUsdt: number;
  transactionCount: number;
  confirmationSecondsSum: number;
  confirmationSecondsCount: number;
  llmCalls: number;
  llmCostUsd: number;
  aaveYieldUsdt: number;
}

function todayDate(): string {
  return new Date().toISOString().split('T')[0]!;
}

let accumulator: DailyAccumulator = {
  date: todayDate(),
  revenueUsdc: 0,
  revenueUsdt: 0,
  transactionCount: 0,
  confirmationSecondsSum: 0,
  confirmationSecondsCount: 0,
  llmCalls: 0,
  llmCostUsd: 0,
  aaveYieldUsdt: 0,
};

/** Reset accumulator when the date rolls over. */
function ensureAccumulatorDate(): void {
  const today = todayDate();
  if (accumulator.date !== today) {
    accumulator = {
      date: today,
      revenueUsdc: 0,
      revenueUsdt: 0,
      transactionCount: 0,
      confirmationSecondsSum: 0,
      confirmationSecondsCount: 0,
      llmCalls: 0,
      llmCostUsd: 0,
      aaveYieldUsdt: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Recording functions
// ---------------------------------------------------------------------------

/**
 * recordTransaction — Log a completed payment forwarding.
 *
 * Called by the monitor after a payment is confirmed and forwarded.
 *
 * @param paymentId — for logging / future cross-reference
 * @param revenueUsdt — relay fee collected (USDT, decimal string)
 * @param revenueUsdc — x402 API fee collected (USDC, decimal string)
 * @param confirmationSeconds — how long the payment took to confirm
 */
export function recordTransaction(
  paymentId: string,
  revenueUsdt: string,
  revenueUsdc: string = '0',
  confirmationSeconds: number = 0,
): void {
  ensureAccumulatorDate();
  accumulator.revenueUsdt += parseFloat(revenueUsdt);
  accumulator.revenueUsdc += parseFloat(revenueUsdc);
  accumulator.transactionCount += 1;
  if (confirmationSeconds > 0) {
    accumulator.confirmationSecondsSum += confirmationSeconds;
    accumulator.confirmationSecondsCount += 1;
  }
  console.log(
    `[metrics] Transaction recorded. id=${paymentId} ` +
    `revenueUsdt=${revenueUsdt} revenueUsdc=${revenueUsdc}`,
  );
}

/**
 * recordLlmCall — Track inference spend.
 *
 * Called every time OpenClaw completes a session. `costUsd` is estimated
 * from model pricing and token counts.
 *
 * The agent uses this data to enforce its cognitive budget — if daily LLM
 * spend is trending towards the limit, it should avoid triggering additional
 * sessions for low-priority anomalies.
 */
export function recordLlmCall(costUsd: number): void {
  ensureAccumulatorDate();
  accumulator.llmCalls += 1;
  accumulator.llmCostUsd += costUsd;
}

/**
 * recordAaveYield — Log yield earned from Aave deposits.
 *
 * TODO: compute actual yield by comparing Aave position at start-of-day
 * vs end-of-day. Called once at end-of-day during rollup.
 */
export function recordAaveYield(yieldUsdt: number): void {
  ensureAccumulatorDate();
  accumulator.aaveYieldUsdt += yieldUsdt;
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * getDailyMetrics — Retrieve persisted metrics for a specific date.
 *
 * Returns null if no rollup exists for that date (e.g., today's data
 * hasn't been rolled up yet — use getRollingMetrics for today).
 */
export function getDailyMetrics(date: string): MetricsDaily | null {
  const row = db.prepare('SELECT * FROM metrics_daily WHERE date = ?').get(date);
  return (row as MetricsDaily) ?? null;
}

/**
 * getRollingMetrics — Aggregated metrics over the last N days.
 *
 * Combines persisted daily rollups from the DB with the current in-memory
 * accumulator so that today's transactions appear immediately without waiting
 * for the 23:55 rollup cron.
 */
export function getRollingMetrics(days: number): {
  totalRevenueUsdt: number;
  totalRevenueUsdc: number;
  totalTransactions: number;
  avgDailyTransactions: number;
  avgConfirmationSeconds: number;
  totalLlmCalls: number;
  totalLlmCostUsd: number;
  totalAaveYieldUsdt: number;
  periodDays: number;
} {
  ensureAccumulatorDate();

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  // Query persisted rows, excluding today (the in-memory accumulator covers today).
  const today = todayDate();
  const row = db.prepare(`
    SELECT
      SUM(CAST(revenue_usdt AS REAL))       AS total_revenue_usdt,
      SUM(CAST(revenue_usdc AS REAL))       AS total_revenue_usdc,
      SUM(transaction_count)                AS total_transactions,
      AVG(avg_confirmation_seconds)         AS avg_confirmation_seconds,
      SUM(llm_calls)                        AS total_llm_calls,
      SUM(CAST(llm_cost_usd AS REAL))       AS total_llm_cost_usd,
      SUM(CAST(aave_yield_usdt AS REAL))    AS total_aave_yield_usdt,
      COUNT(*)                              AS day_count
    FROM metrics_daily
    WHERE date >= ? AND date < ?
  `).get(cutoff, today) as {
    total_revenue_usdt: number;
    total_revenue_usdc: number;
    total_transactions: number;
    avg_confirmation_seconds: number;
    total_llm_calls: number;
    total_llm_cost_usd: number;
    total_aave_yield_usdt: number;
    day_count: number;
  };

  // Add today's in-memory accumulator on top of the historical DB rows.
  const totalRevenueUsdt = (row.total_revenue_usdt ?? 0) + accumulator.revenueUsdt;
  const totalRevenueUsdc = (row.total_revenue_usdc ?? 0) + accumulator.revenueUsdc;
  const totalTransactions = (row.total_transactions ?? 0) + accumulator.transactionCount;
  const totalLlmCalls     = (row.total_llm_calls ?? 0)   + accumulator.llmCalls;
  const totalLlmCostUsd   = (row.total_llm_cost_usd ?? 0) + accumulator.llmCostUsd;
  const totalAaveYield    = (row.total_aave_yield_usdt ?? 0) + accumulator.aaveYieldUsdt;

  // Confirmation time: weighted average of historical avg + today's running sum.
  const historicalConfSec = row.avg_confirmation_seconds ?? 0;
  const historicalConfN   = row.day_count ?? 0;
  const todayAvgConf = accumulator.confirmationSecondsCount > 0
    ? accumulator.confirmationSecondsSum / accumulator.confirmationSecondsCount
    : 0;
  const avgConfirmationSeconds = (historicalConfN + (todayAvgConf > 0 ? 1 : 0)) > 0
    ? (historicalConfSec * historicalConfN + todayAvgConf) / (historicalConfN + (todayAvgConf > 0 ? 1 : 0))
    : 0;

  // Day count includes today if it has any activity.
  const dayCount = Math.max((row.day_count ?? 0) + 1, 1);

  return {
    totalRevenueUsdt,
    totalRevenueUsdc,
    totalTransactions,
    avgDailyTransactions: totalTransactions / dayCount,
    avgConfirmationSeconds,
    totalLlmCalls,
    totalLlmCostUsd,
    totalAaveYieldUsdt: totalAaveYield,
    periodDays: days,
  };
}

// ---------------------------------------------------------------------------
// End-of-day rollup
// ---------------------------------------------------------------------------

/**
 * rollupDailyMetrics — Write the in-memory accumulator to the DB.
 *
 * Called by the scheduler at 23:55 each day. Uses INSERT OR REPLACE so
 * re-running (e.g., after a crash and restart) overwrites with the latest
 * accumulator state.
 *
 * Also records the current wallet balances as an end-of-day snapshot.
 */
export async function rollupDailyMetrics(): Promise<void> {
  ensureAccumulatorDate();

  // Fetch current wallet balances for the snapshot.
  const { getUsdtBalance, getUsdcBalance } = await import('../wallet/evm');
  const { getDepositedBalance } = await import('../wallet/aave');

  const [walletBalanceUsdt, walletBalanceUsdc, currentAaveBalance] = await Promise.all([
    getUsdtBalance('arbitrum'),
    getUsdcBalance('base'),
    getDepositedBalance().catch(() => '0'),
  ]);

  // Compute Aave yield: current aToken balance minus start-of-day balance.
  // The SOD balance is written at the end of the previous rollup. On first
  // run it won't exist yet, so yield defaults to 0 for day one.
  const sodBalanceRaw = getSetting(SETTING_KEYS.AAVE_SOD_BALANCE_USDT);
  const sodBalance = sodBalanceRaw !== null ? parseFloat(sodBalanceRaw) : parseFloat(currentAaveBalance);
  const aaveYield = Math.max(0, parseFloat(currentAaveBalance) - sodBalance);
  recordAaveYield(aaveYield);

  // Persist today's closing Aave balance as tomorrow's start-of-day reference.
  setSetting(SETTING_KEYS.AAVE_SOD_BALANCE_USDT, currentAaveBalance);

  const avgConfirmation =
    accumulator.confirmationSecondsCount > 0
      ? accumulator.confirmationSecondsSum / accumulator.confirmationSecondsCount
      : 0;

  db.prepare(`
    INSERT OR REPLACE INTO metrics_daily
      (date, revenue_usdc, revenue_usdt, transaction_count,
       avg_confirmation_seconds, llm_calls, llm_cost_usd,
       aave_yield_usdt, wallet_balance_usdt, wallet_balance_usdc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accumulator.date,
    accumulator.revenueUsdc.toFixed(6),
    accumulator.revenueUsdt.toFixed(6),
    accumulator.transactionCount,
    avgConfirmation,
    accumulator.llmCalls,
    accumulator.llmCostUsd.toFixed(6),
    accumulator.aaveYieldUsdt.toFixed(6),
    walletBalanceUsdt,
    walletBalanceUsdc,
  );

  console.log(
    `[metrics] Daily rollup complete for ${accumulator.date}. ` +
    `Aave yield today: ${aaveYield.toFixed(6)} USDT.`,
  );
}
