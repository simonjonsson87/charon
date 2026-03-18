/**
 * src/intelligence/network.ts — TRON network timing intelligence service
 *
 * Reports on current TRON network conditions and predicts confirmation times.
 *
 * What makes this useful vs. generic blockchain explorers:
 *   The confirmation time percentiles (p50/p95/p99) come from THIS relay's
 *   own transaction history in the confirmation_times table — real measurements
 *   from real payments, not theoretical network specs. The data gets better
 *   as the relay processes more transactions.
 *
 * Data flow:
 *   1. Every 30 seconds, fetchNetworkStats() polls TRON RPC for current TPS
 *      and block time.
 *   2. getTimingSignal() assembles the real-time stats, DB-derived percentiles,
 *      and an LLM-generated forecast into a response object.
 *   3. The /network/timing endpoint serves this object from cache.
 *
 * LLM boundary:
 *   generateForecast() is the only LLM call in this module. It receives the
 *   hourly load pattern from the DB and generates a human-readable forecast
 *   array ("expect slower confirmations between 14:00–18:00 UTC") plus
 *   a recommendation. The LLM does NOT compute the percentiles.
 */

import axios from 'axios';
import { getConfirmationPercentiles, getHourlyLoadPattern } from '../db/queries/confirmations';
import type { ConfirmationPercentiles, HourlyLoadPoint } from '../db/queries/confirmations';

export type LoadLevel = 'low' | 'moderate' | 'high' | 'congested';

export interface NetworkStats {
  /** Current network TPS (transactions per second). */
  tps: number;
  /** Average block time in seconds over the last 10 blocks. */
  avgBlockTimeSeconds: number;
  loadLevel: LoadLevel;
  /** Unix timestamp (ms) when these stats were fetched. */
  fetchedAt: number;
}

export interface ForecastPoint {
  /** UTC hour (0–23). */
  hour: number;
  expectedLoadLevel: LoadLevel;
  expectedP50Seconds: number;
}

export interface TimingSignal {
  currentStats: NetworkStats;
  /** Percentiles derived from this relay's own transaction history. */
  percentiles: ConfirmationPercentiles | null;
  /** 24-hour forecast array with per-hour load expectations. */
  forecast: ForecastPoint[];
  /** Human-readable summary and recommendation from the LLM. */
  forecastNarrative: string;
  /** How many relay transactions the percentile data is based on. */
  sampleSize: number;
}

let latestStats: NetworkStats | null = null;
let cachedSignal: TimingSignal | null = null;
let networkPollInterval: ReturnType<typeof setInterval> | null = null;

const NETWORK_POLL_INTERVAL_MS = 30_000; // 30 seconds
const PERCENTILE_WINDOW_DAYS = 14; // use 14 days of data for percentiles
const FORECAST_WINDOW_DAYS = 30; // use 30 days for the hourly load pattern

// TRON mainnet TPS thresholds for load classification.
const TPS_MODERATE = 1_500;
const TPS_HIGH = 2_500;
const TPS_CONGESTED = 3_500;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * startNetworkMonitor — Begin polling TRON RPC for network stats.
 *
 * Idempotent — safe to call at startup. The first stats are fetched
 * immediately (no waiting for the first interval tick).
 */
export function startNetworkMonitor(): void {
  if (networkPollInterval) return;

  // Fetch immediately on startup.
  fetchAndCacheNetworkStats().catch((err) => {
    console.error('[network] Initial stats fetch failed:', err);
  });

  networkPollInterval = setInterval(() => {
    fetchAndCacheNetworkStats().catch((err) => {
      console.error('[network] Stats refresh failed:', err);
    });
  }, NETWORK_POLL_INTERVAL_MS);

  console.log(`[network] Monitor started. Polling every ${NETWORK_POLL_INTERVAL_MS / 1000}s.`);
}

/**
 * getTimingSignal — Assemble and return the full timing intelligence object.
 *
 * This is called by the GET /network/timing route. It assembles:
 *   - Latest network stats (from in-memory cache, updated every 30s).
 *   - Confirmation percentiles from the DB (query on each call, lightweight).
 *   - Forecast (re-generated from the hourly pattern when the cache is stale).
 *
 * The forecast is regenerated at most once per hour to avoid excessive LLM calls.
 */
export async function getTimingSignal(): Promise<TimingSignal | null> {
  if (!latestStats) return null;

  const percentiles = getConfirmationPercentiles(PERCENTILE_WINDOW_DAYS);
  const hourlyPattern = getHourlyLoadPattern(FORECAST_WINDOW_DAYS);

  // Regenerate forecast if the cached signal is stale (> 1 hour old).
  const signalAge = cachedSignal ? Date.now() - cachedSignal.currentStats.fetchedAt : Infinity;
  const { forecast, forecastNarrative } =
    signalAge > 60 * 60 * 1000
      ? await generateForecast(hourlyPattern)
      : { forecast: cachedSignal?.forecast ?? [], forecastNarrative: cachedSignal?.forecastNarrative ?? '' };

  const signal: TimingSignal = {
    currentStats: latestStats,
    percentiles,
    forecast,
    forecastNarrative,
    sampleSize: percentiles?.sampleSize ?? 0,
  };

  cachedSignal = signal;
  return signal;
}

// ---------------------------------------------------------------------------
// Internal: data fetching
// ---------------------------------------------------------------------------

async function fetchAndCacheNetworkStats(): Promise<void> {
  const tronGridUrl = process.env.TRON_RPC_URL ?? 'https://api.trongrid.io';
  const headers: Record<string, string> = {};
  if (process.env.TRON_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRON_API_KEY;

  try {
    // Fetch the last 10 blocks to compute average block time and estimate TPS.
    // Uses POST /wallet/getblockbylatestnum — the v1 block list endpoint requires
    // a specific API plan and returns 404 on free-tier TronGrid keys.
    const blocksRes = await axios.post(
      `${tronGridUrl}/wallet/getblockbylatestnum`,
      { num: 10 },
      { headers, timeout: 5000 },
    );

    const blocks: { block_header: { raw_data: { timestamp: number; number: number } } }[] =
      blocksRes.data?.block ?? [];

    let avgBlockTimeSeconds = 3.0;
    let estimatedTps = 1_200;

    if (blocks.length >= 2) {
      const newest = blocks[0]!.block_header.raw_data;
      const oldest = blocks[blocks.length - 1]!.block_header.raw_data;
      const spanMs = newest.timestamp - oldest.timestamp;
      const blockCount = newest.number - oldest.number;

      if (blockCount > 0 && spanMs > 0) {
        avgBlockTimeSeconds = spanMs / blockCount / 1000;
        // Rough TPS estimate: ~50 txns per block at moderate load
        estimatedTps = 50 / avgBlockTimeSeconds;
      }
    }

    // Refine TPS with nodeinfo if available.
    try {
      const nodeRes = await axios.post(
        `${tronGridUrl}/wallet/getnodeinfo`,
        {},
        { headers, timeout: 3000 },
      );
      const tps: number | undefined = nodeRes.data?.machineInfo?.tps;
      if (tps && tps > 0) estimatedTps = tps;
    } catch {
      // nodeinfo is optional — block-based estimate is good enough.
    }

    latestStats = {
      tps: Math.round(estimatedTps),
      avgBlockTimeSeconds: Math.round(avgBlockTimeSeconds * 10) / 10,
      loadLevel: computeLoadLevel(estimatedTps),
      fetchedAt: Date.now(),
    };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    console.warn(`[network] TronGrid stats fetch failed${status ? ` (HTTP ${status})` : ''} — using cached or simulated values.`);

    // If we have no cached stats yet, provide a reasonable default.
    if (!latestStats) {
      const tps = 1_200;
      latestStats = {
        tps,
        avgBlockTimeSeconds: 3.0,
        loadLevel: computeLoadLevel(tps),
        fetchedAt: Date.now(),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: deterministic computations
// ---------------------------------------------------------------------------

/**
 * computeLoadLevel — Classify current TPS as a qualitative load level.
 *
 * Thresholds are based on TRON mainnet historical TPS data.
 * TRON's practical throughput limit is ~2000 TPS for smart contract txns.
 */
function computeLoadLevel(tps: number): LoadLevel {
  if (tps < TPS_MODERATE) return 'low';
  if (tps < TPS_HIGH) return 'moderate';
  if (tps < TPS_CONGESTED) return 'high';
  return 'congested';
}

// ---------------------------------------------------------------------------
// Internal: LLM forecast generation (the ONLY LLM call in this module)
// ---------------------------------------------------------------------------

/**
 * generateForecast — Use the LLM to interpret hourly load patterns.
 *
 * The hourly load data (average confirmation seconds per hour of day, from
 * the relay's own DB) is passed to the LLM. It returns:
 *   1. A structured forecast array — which hours are expected to be busy.
 *   2. A human-readable narrative ("Expect slower confirmations on weekday
 *      afternoons UTC; plan accordingly for high-value payment deadlines.").
 *
 * The LLM is called at most once per hour (cache is checked in getTimingSignal).
 * It is NOT called on every API request.
 */
async function generateForecast(
  hourlyPattern: HourlyLoadPoint[],
): Promise<{ forecast: ForecastPoint[]; forecastNarrative: string }> {
  // Deterministic fallback used if the bridge is unavailable or the pattern is empty.
  const deterministicForecast: ForecastPoint[] = hourlyPattern.map((point) => ({
    hour: point.hour,
    expectedLoadLevel: computeLoadLevel(
      point.avgConfirmationSeconds > 30 ? TPS_HIGH : TPS_MODERATE,
    ),
    expectedP50Seconds: point.avgConfirmationSeconds,
  }));

  if (hourlyPattern.length === 0) {
    return {
      forecast: deterministicForecast,
      forecastNarrative:
        'Insufficient transaction history to generate a network timing forecast. ' +
        'Forecast improves as transaction volume grows.',
    };
  }

  const { runAgentSession } = await import('../agent/client');

  const result = await runAgentSession({
    message:
      'Based on this hourly TRON confirmation time data from our relay\'s own transaction history, ' +
      'write a one-paragraph forecast narrative. Identify the busiest and quietest UTC hours, ' +
      'and give a practical recommendation for scheduling high-value payment deadlines. ' +
      'Data (hour → avg confirmation seconds): ' + JSON.stringify(hourlyPattern),
    agent: 'main',
    sessionId: `network-forecast-${Date.now()}`,
    thinking: 'low',
  });

  return {
    forecast: deterministicForecast,
    forecastNarrative: result.text ||
      'Network timing data is based on this relay\'s own transaction history.',
  };
}
