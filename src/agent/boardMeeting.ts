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
 *   - Current energy market data (includes live TRX price and gas costs)
 *   - Live EVM gas prices (Arbitrum + Base) and ETH/USD price for cost estimates
 *   - Akash escrow drain rate converted to daily USD cost for runway
 */

import { runAgentSession } from './client';
import { getRollingMetrics } from '../monitoring/metrics';
import { getBalance, getTronWalletAddress } from '../wallet/tron';
import { getUsdcBalance, getUsdtBalance, getEthBalance, getGasPriceGwei } from '../wallet/evm';
import { getDepositedBalance, getCurrentApy } from '../wallet/aave';
import { getAgentTrxBalance } from '../wallet/tronGasfree';
import { getAktBalance, getEscrowBalance, type EscrowStatus } from '../wallet/akash';
import { getBridgeFees, type BridgeQuote } from '../wallet/bridge';
import { getLatestEnergyData, type EnergyData } from '../intelligence/energy';
import { getAllExperiments } from '../db/queries/experiments';
import { getLogs } from '../db/logger';
import { getSettingAsFloat, SETTING_KEYS } from '../db/queries/settings';
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
/**
 * assembleBoardMeetingContext — Collect all data the agent needs for a board meeting.
 *
 * Exported so that /admin/status can return the same parcel without triggering
 * a full agent session.
 */
export async function assembleBoardMeetingContext(): Promise<Record<string, unknown>> {
  const [
    metrics24h,
    metrics7d,
    metrics30d,
    balances,
    pendingExperiments,
    allExperiments,
    energyData,
    operationalStats,
    bridgeFeeQuotes,
    ethPriceUsd,
    aktPriceUsd,
    arbGasPriceGwei,
    baseGasPriceGwei,
  ] = await Promise.all([
    Promise.resolve(getRollingMetrics(1)),
    Promise.resolve(getRollingMetrics(7)),
    Promise.resolve(getRollingMetrics(30)),
    assembleBalanceSnapshot(),
    Promise.resolve(getAllExperiments('pending')),
    Promise.resolve(getAllExperiments()),
    Promise.resolve(getLatestEnergyData()),
    assembleOperationalStats(),
    getBridgeFees('10').catch((): BridgeQuote[] => []),
    fetchTokenPriceUsd('ethereum').catch(() => 0),
    fetchTokenPriceUsd('akash-network').catch(() => 0),
    getGasPriceGwei('arbitrum').catch(() => 0),
    getGasPriceGwei('base').catch(() => 0),
  ]);

  let akashStatus: EscrowStatus | null = null;
  const dseq = process.env.AKASH_DEPLOYMENT_DSEQ;
  if (dseq) {
    akashStatus = await getEscrowBalance(dseq).catch(() => null);
  }

  // Daily Akash hosting cost: drain rate → AKT/month → AKT/day → USD/day.
  const dailyAkashCostUsd = (akashStatus?.monthlyBurnAkt != null && aktPriceUsd > 0)
    ? (akashStatus.monthlyBurnAkt / 30) * aktPriceUsd
    : 0;

  const runway = calculateRunway(balances, metrics7d.totalLlmCostUsd / 7, dailyAkashCostUsd);

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentAnomalies = getLogs({ category: 'ANOMALY', since: since24h, limit: 20 });

  const toolCosts = {
    note: 'Bridge fees include protocol fee + destination gas. Gas costs are live (current gas price × estimated gas units × ETH price). All amounts in USD.',
    referenceAmountUsd: '10',
    bridgeFeeQuotes,
    gasEstimatesUsd: computeGasEstimates(arbGasPriceGwei, baseGasPriceGwei, ethPriceUsd, energyData),
  };

  return {
    timestamp: new Date().toISOString(),
    metrics: {
      last24h: metrics24h,
      last7d: metrics7d,
      last30d: metrics30d,
    },
    balances,
    runway,
    // DB value takes priority over env var — the agent updates the DB via update_fee().
    currentRelayFeePercent: getSettingAsFloat(
      SETTING_KEYS.RELAY_FEE_PERCENT,
      parseFloat(process.env.RELAY_FEE_PERCENT ?? '0.3'),
    ),
    akashHosting: akashStatus,
    toolCosts,
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
}

export async function runBoardMeeting(): Promise<void> {
  console.log('[board-meeting] Assembling context...');

  const context = await assembleBoardMeetingContext();

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
  dailyAkashCostUsd: number,
): RunwayData {
  // Tron energy sponsorship overhead: ~$0.05/day at low volume.
  // EVM gas for rebalancing ops: ~$0.05/day.
  // Refined by the agent over time through experiment outcomes in MEMORY.md.
  const dailyGasCostUsd = 0.10;
  const dailyOperatingCostUsd = dailyLlmCostUsd + dailyAkashCostUsd + dailyGasCostUsd;
  const liquidUsd = parseFloat(balances.totalUsdtEquivalent);
  const runwayDays = dailyOperatingCostUsd > 0 ? liquidUsd / dailyOperatingCostUsd : Infinity;

  return {
    dailyOperatingCostUsd,
    liquidUsd,
    runwayDays: Math.round(runwayDays),
  };
}

// TODO(competitor-pricing): Add live competitor pricing data to the board meeting context.
// Competitors: NOWPayments (0.5%), Plisio (0.5%), CoinPayments (0.5%),
// CryptoProcessing (0.8%), TripleA (1.0%).
// None currently expose a reliable public API for TRC-20 USDT rates.
// Options: scrape their pricing pages, use a third-party aggregator, or maintain
// a manually-updated static list checked into AGENTS.md.

/**
 * fetchTokenPriceUsd — Fetch a token's current USD price from CoinGecko.
 *
 * @param coinId  CoinGecko coin ID (e.g. 'ethereum', 'akash-network')
 */
async function fetchTokenPriceUsd(coinId: string): Promise<number> {
  const axios = (await import('axios')).default;
  const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: { ids: coinId, vs_currencies: 'usd' },
    timeout: 5_000,
  });
  return res.data?.[coinId]?.usd ?? 0;
}

/**
 * computeGasEstimates — Calculate live gas cost estimates per tool.
 *
 * Uses current on-chain gas prices (fetched from each chain's provider) and
 * the current ETH/USD price to give the agent accurate cost figures.
 *
 * Gas unit estimates per operation type (approximate):
 *   Uniswap v3 swap on Arbitrum (wrap + approve + exactInputSingle): ~330k gas
 *   Uniswap v3 swap on Base (approve/wrap + exactInputSingle):        ~280k gas
 *   Aave v3 supply (approve + supply):                                ~250k gas
 *   Aave v3 withdraw:                                                 ~200k gas
 *
 * Tron costs use the energy module's burn cost (in TRX) × TRX/USD.
 * A SunSwap v2 swap uses ~2.5× more energy than a plain USDT transfer.
 */
function computeGasEstimates(
  arbGasPriceGwei: number,
  baseGasPriceGwei: number,
  ethPriceUsd: number,
  energyData: EnergyData | null,
): Record<string, unknown> {
  const evmUsd = (gasPriceGwei: number, gasUnits: number): string => {
    if (!ethPriceUsd || !gasPriceGwei) return 'unknown';
    return `$${(gasPriceGwei * 1e-9 * gasUnits * ethPriceUsd).toFixed(4)}`;
  };

  const tronSwapUsd = energyData
    ? `$${(energyData.burnCostTrx * 2.5 * energyData.trxPriceUsd).toFixed(4)}`
    : 'unknown';

  return {
    source: 'live (on-chain gas price × estimated gas units × CoinGecko price)',
    ethPriceUsd,
    arbGasPriceGwei,
    baseGasPriceGwei,
    trxPriceUsd:             energyData?.trxPriceUsd ?? null,
    swap_tron_usdt_for_trx:  tronSwapUsd,
    swap_tron_trx_for_usdt:  tronSwapUsd,
    swap_usdt_to_eth_arb:    evmUsd(arbGasPriceGwei, 330_000),
    swap_eth_to_usdt_arb:    evmUsd(arbGasPriceGwei, 330_000),
    swap_usdc_to_eth_base:   evmUsd(baseGasPriceGwei, 280_000),
    swap_eth_to_usdc_base:   evmUsd(baseGasPriceGwei, 280_000),
    deposit_to_aave:         evmUsd(arbGasPriceGwei, 250_000),
    withdraw_from_aave:      evmUsd(arbGasPriceGwei, 200_000),
    deposit_usdc_to_aave:    evmUsd(baseGasPriceGwei, 250_000),
    withdraw_usdc_from_aave: evmUsd(baseGasPriceGwei, 200_000),
    topup_akash_escrow:      '<$0.01',
  };
}

/**
 * buildBoardMeetingPrompt — Construct the structured prompt for the board meeting.
 *
 * The prompt tells the agent what it needs to assess. The context object
 * is injected separately by runAgentSession().
 */
export function buildBoardMeetingPrompt(context: Record<string, unknown>): string {
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
| context.akashHosting (escrow balance + runway, null if AKASH_DEPLOYMENT_DSEQ unset) | get_akash_escrow_status |
| context.toolCosts.bridgeFeeQuotes (live quotes for all bridge routes at $10 ref) | get_bridge_fees |
| context.toolCosts.gasEstimatesUsd (live gas cost per tool: chain gas price × units × ETH/USD) | — |
| context.pendingExperiments + context.experimentHistory | get_experiments |
| context.currentRelayFeePercent (from DB — reflects any agent update_fee calls) | — |
| context.operationalStats (developer count, pool size, success rate) | — |
| context.recentAnomalies | — |

## Tools to call only for ACTIONS

- **Decisions**: update_fee, deposit_to_aave, withdraw_from_aave, swap_tron_usdt_for_trx, swap_usdt_to_eth_arb, bridge_tron_to_arbitrum, bridge_arbitrum_to_tron, bridge_tron_to_base, bridge_base_to_arbitrum, bridge_arbitrum_usdc_to_base, bridge_arbitrum_eth_to_base, bridge_base_usdc_to_akt, topup_akash_escrow
- **Recording**: save_experiment (before any significant action), evaluate_experiment (for overdue experiments)
- **Memory**: update_memory (once, at the end, with a 2–3 paragraph summary)

## Agenda

1. **Financial review** — use context.metrics to assess 24h and 7d performance.
2. **Experiment evaluation** — check context.pendingExperiments for any past their checkDate. Call evaluate_experiment for those.
3. **Capital allocation** — use context.balances + context.runway. Act if TRX reserve is low, Aave needs rebalancing, or Akash escrow (context.akashHosting) is below 1.5 months.
4. **Pricing** — review context.currentRelayFeePercent relative to revenue trend. If adjusting: save_experiment first, then update_fee.
5. **Summary** — call update_memory once with a concise 2–3 paragraph board meeting summary.
`.trim();
}

