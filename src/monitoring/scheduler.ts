/**
 * src/monitoring/scheduler.ts — Cron scheduler and orchestration layer
 *
 * This is the nerve centre of the server orchestration. It decides WHEN to
 * call OpenClaw; OpenClaw decides WHAT to do when called.
 *
 * The server is fully autonomous — it runs its business logic (payment
 * monitoring, fee collection, Aave yield) without any LLM involvement.
 * The LLM is called only at scheduled moments (board meetings, anomaly
 * responses) and only when the situation warrants the inference cost.
 *
 * Cognitive budget principle (from AGENTS.md):
 *   Each LLM session costs money. The scheduler respects a daily budget by:
 *   - Running the board meeting once per day (highest quality, claude-opus).
 *   - Triggering decision sessions only for medium+ priority anomalies.
 *   - Deferring low-priority anomalies to the next board meeting as context.
 *   - Skipping decision sessions if the daily LLM budget is exhausted.
 *
 * Cron jobs registered:
 *   1. Board meeting: BOARD_MEETING_CRON (default: midnight UTC)
 *   2. Anomaly check: every 15 minutes
 *   3. Daily metric rollup: 23:55 UTC
 *   4. Payment expiry: every minute
 *   5. USDC consolidation: daily at 01:00 UTC
 */

import cron from 'node-cron';
import { runBoardMeeting } from '../agent/boardMeeting';
import { handleAnomaly } from '../agent/decisionLayer';
import { checkAll } from './anomaly';
import { rollupDailyMetrics, getRollingMetrics } from './metrics';
import { expireOldPayments } from '../db/queries/payments';
import { swapUsdcToUsdt } from '../wallet/evm';
import { getUsdcBalance } from '../wallet/evm';
import { dbLog } from '../db/logger';

/** Minimum daily LLM budget in USD before we start skipping low-priority sessions. */
const DAILY_LLM_BUDGET_USD = 5.0;

/** Minimum USDC balance before triggering a consolidation swap. */
const USDC_CONSOLIDATION_THRESHOLD = '10.00';

/**
 * startScheduler — Register all cron jobs.
 *
 * Called once at startup. All jobs run in UTC. The cron library handles
 * DST transitions automatically because we operate in UTC only.
 */
export function startScheduler(): void {
  // ---- 1. Board meeting ------------------------------------------------
  // The board meeting is the primary strategic reasoning session. It runs
  // once per day on the configured schedule (default: midnight UTC).
  // Claude Opus is used for board meetings (configured in openclaw.json).
  const boardMeetingCron = process.env.BOARD_MEETING_CRON ?? '0 0 * * *';

  cron.schedule(boardMeetingCron, async () => {
    console.log('[scheduler] Board meeting triggered.');
    dbLog('AGENT', 'info', 'Board meeting started (scheduled)');
    try {
      await runBoardMeeting();
      console.log('[scheduler] Board meeting completed.');
      dbLog('AGENT', 'info', 'Board meeting completed');
    } catch (err) {
      console.error('[scheduler] Board meeting failed:', err);
      dbLog('AGENT', 'error', 'Board meeting failed', { error: String(err) });
    }
  }, { timezone: 'UTC' });

  // ---- 2. Anomaly check ------------------------------------------------
  // Runs every 15 minutes. High-priority anomalies trigger immediate decision
  // sessions; lower-priority ones are deferred to the next board meeting.
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runAnomalyCheck();
    } catch (err) {
      console.error('[scheduler] Anomaly check failed:', err);
    }
  });

  // ---- 3. Daily metric rollup ------------------------------------------
  cron.schedule('55 23 * * *', async () => {
    console.log('[scheduler] Running daily metric rollup...');
    try {
      await rollupDailyMetrics();
    } catch (err) {
      console.error('[scheduler] Metric rollup failed:', err);
    }
  }, { timezone: 'UTC' });

  // ---- 4. Payment expiry -----------------------------------------------
  // Runs every minute. Marks stale pending payments as expired and releases
  // their addresses back to the pool.
  cron.schedule('* * * * *', () => {
    try {
      const count = expireOldPayments();
      if (count > 0) {
        console.log(`[scheduler] Expired ${count} pending payment(s).`);
      }
    } catch (err) {
      console.error('[scheduler] Payment expiry failed:', err);
    }
  });

  // ---- 5. USDC consolidation -------------------------------------------
  // Runs daily at 01:00 UTC. Swaps USDC earned from x402 fees to USDT for
  // Aave deployment. Only triggers if balance exceeds the minimum threshold.
  cron.schedule('0 1 * * *', async () => {
    console.log('[scheduler] Running USDC consolidation check...');
    try {
      await runUsdcConsolidation();
    } catch (err) {
      console.error('[scheduler] USDC consolidation failed:', err);
    }
  }, { timezone: 'UTC' });

  console.log('[scheduler] All cron jobs registered.');
  console.log(`[scheduler] Board meeting schedule: ${boardMeetingCron}`);
}

// ---------------------------------------------------------------------------
// Internal job implementations
// ---------------------------------------------------------------------------

/**
 * runAnomalyCheck — Execute all anomaly checks and respond to high-priority events.
 *
 * Priority routing:
 *   - critical: trigger decision session immediately, regardless of budget.
 *   - high: trigger decision session if within LLM budget.
 *   - medium/low: defer to next board meeting (logged as context).
 */
async function runAnomalyCheck(): Promise<void> {
  const anomalies = await checkAll();

  if (anomalies.length === 0) return;

  console.log(`[scheduler] ${anomalies.length} anomaly event(s) detected.`);
  dbLog('ANOMALY', 'info', `Anomaly check: ${anomalies.length} event(s) found`, {
    types: anomalies.map((a) => a.type),
  });

  // Check current daily LLM spend to enforce cognitive budget.
  const metrics = getRollingMetrics(1);
  const remainingBudget = DAILY_LLM_BUDGET_USD - metrics.totalLlmCostUsd;

  for (const anomaly of anomalies) {
    if (anomaly.priority === 'critical' || anomaly.priority === 'high') {
      if (remainingBudget <= 0 && anomaly.priority !== 'critical') {
        console.warn(
          `[scheduler] Skipping ${anomaly.type} decision session — daily LLM budget exhausted.`,
        );
        continue;
      }

      console.log(`[scheduler] Triggering decision session for ${anomaly.type} (${anomaly.priority}).`);
      dbLog('ANOMALY', anomaly.priority === 'critical' ? 'error' : 'warn',
        `Handling anomaly: ${anomaly.type}`, { priority: anomaly.priority, description: anomaly.description });
      await handleAnomaly(anomaly).catch((err) => {
        console.error(`[scheduler] Decision session failed for ${anomaly.type}:`, err);
        dbLog('ANOMALY', 'error', `Anomaly handler failed: ${anomaly.type}`, { error: String(err) });
      });
    } else {
      // Low/medium anomalies are logged; the board meeting agent will see them
      // as context at the next board meeting.
      console.log(
        `[scheduler] Deferring ${anomaly.type} (${anomaly.priority}) to next board meeting.`,
      );
    }
  }
}

/**
 * runUsdcConsolidation — Swap USDC (Base) to USDT (Arbitrum) if balance exceeds threshold.
 *
 * Chain flow:
 *   x402 fees → USDC on Base → [Velora cross-chain swap] → USDT on Arbitrum → idle
 *
 * This job only handles the swap step. The USDT lands on Arbitrum as idle capital.
 * Whether to deposit it into Aave is a separate decision made by the agent at the
 * next board meeting (via get_capital_summary → deposit_to_aave). Keeping these
 * two steps separate means the consolidation cron never makes discretionary capital
 * allocation decisions — only the agent does.
 *
 * The TRON relay float is funded separately: relay fees (0.3% per payment) accrue
 * directly as USDT on TRON and do not flow through this consolidation path.
 *
 * The swap only runs if the USDC balance exceeds the minimum threshold to avoid
 * DEX fees eating into small amounts.
 */
async function runUsdcConsolidation(): Promise<void> {
  const usdcBalance = await getUsdcBalance('base');
  const balanceNum = parseFloat(usdcBalance);
  const thresholdNum = parseFloat(USDC_CONSOLIDATION_THRESHOLD);

  if (balanceNum < thresholdNum) {
    console.log(
      `[scheduler] USDC balance (${usdcBalance}) below threshold (${USDC_CONSOLIDATION_THRESHOLD}). Skipping consolidation.`,
    );
    return;
  }

  console.log(`[scheduler] Bridging ${usdcBalance} USDC (Base) → USDT (Arbitrum) via deBridge...`);
  const orderId = await swapUsdcToUsdt(usdcBalance);
  // Settlement is async (30s–5min). The USDT will appear on Arbitrum once the
  // deBridge order is fulfilled. The board meeting agent decides whether to
  // deposit it into Aave at the next scheduled session.
  console.log(`[scheduler] Consolidation order submitted. deBridge orderId: ${orderId}`);
  dbLog('CAPITAL', 'info', `USDC consolidation order submitted: ${usdcBalance} USDC Base→Arbitrum`, { orderId });
}
