/**
 * src/db/queries/confirmations.ts — Confirmation timing queries
 *
 * The relay measures actual confirmation times for every transaction it
 * processes and stores them here. These measurements feed the network timing
 * intelligence service, which reports honest p50/p95/p99 figures derived from
 * the agent's own relay history rather than theoretical network specs.
 *
 * The data is also used to forecast whether to advise a user to wait longer
 * (e.g., during a high-load period) before assuming a payment is delayed.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../index';
import type { ConfirmationTime } from '../schema';

export interface ConfirmationPercentiles {
  p50: number; // seconds
  p95: number;
  p99: number;
  sampleSize: number;
}

export interface HourlyLoadPoint {
  /** UTC hour (0–23). */
  hour: number;
  avgConfirmationSeconds: number;
  sampleCount: number;
}

/**
 * recordConfirmation — Persist one timing observation.
 *
 * Called by the monitor loop when a payment reaches 'confirmed' status.
 * `confirmation_seconds` is derived here (not by the caller) to avoid
 * clock skew from passing pre-computed durations.
 */
export function recordConfirmation(
  paymentId: string,
  broadcastAt: string,
  detectedAt: string,
  confirmedAt: string,
  blockHeight: number,
): ConfirmationTime {
  const id = uuidv4();

  // Compute duration in seconds from the ISO strings.
  const detectedMs = new Date(detectedAt).getTime();
  const confirmedMs = new Date(confirmedAt).getTime();
  const confirmationSeconds = Math.round((confirmedMs - detectedMs) / 1000);

  db.prepare(`
    INSERT INTO confirmation_times
      (id, payment_id, broadcast_at, detected_at, confirmed_at,
       confirmation_seconds, block_height)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, paymentId, broadcastAt, detectedAt, confirmedAt, confirmationSeconds, blockHeight);

  return {
    id,
    payment_id: paymentId,
    broadcast_at: broadcastAt,
    detected_at: detectedAt,
    confirmed_at: confirmedAt,
    confirmation_seconds: confirmationSeconds,
    block_height: blockHeight,
  };
}

/**
 * getConfirmationPercentiles — Compute p50/p95/p99 over a rolling window.
 *
 * SQLite doesn't have a built-in PERCENTILE_CONT function, so we fetch the
 * relevant rows ordered by confirmation_seconds and calculate percentiles in
 * JavaScript. This is acceptable at the expected scale (thousands, not
 * millions, of rows per window).
 *
 * Returns null if there are no observations in the window.
 */
export function getConfirmationPercentiles(
  windowDays: number,
): ConfirmationPercentiles | null {
  const cutoff = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const rows = db.prepare(`
    SELECT confirmation_seconds
    FROM confirmation_times
    WHERE confirmed_at >= ?
    ORDER BY confirmation_seconds ASC
  `).all(cutoff) as { confirmation_seconds: number }[];

  if (rows.length === 0) return null;

  const values = rows.map((r) => r.confirmation_seconds);
  const n = values.length;

  const percentile = (p: number): number => {
    const idx = Math.max(0, Math.ceil((p / 100) * n) - 1);
    return values[idx] ?? 0;
  };

  return {
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    sampleSize: n,
  };
}

/**
 * getHourlyLoadPattern — Average confirmation time bucketed by hour of day.
 *
 * Returns an array of 24 data points (one per UTC hour). Hours with no
 * observations in the window are omitted from the result — callers should
 * handle gaps. This data feeds the LLM in the network timing service so it
 * can generate a human-readable forecast about busy vs. quiet hours.
 */
export function getHourlyLoadPattern(windowDays: number): HourlyLoadPoint[] {
  const cutoff = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // SQLite's strftime('%H', ...) extracts the UTC hour from an ISO timestamp.
  const rows = db.prepare(`
    SELECT
      CAST(strftime('%H', confirmed_at) AS INTEGER) AS hour,
      AVG(confirmation_seconds) AS avg_confirmation_seconds,
      COUNT(*) AS sample_count
    FROM confirmation_times
    WHERE confirmed_at >= ?
    GROUP BY hour
    ORDER BY hour ASC
  `).all(cutoff) as { hour: number; avg_confirmation_seconds: number; sample_count: number }[];

  return rows.map((r) => ({
    hour: r.hour,
    avgConfirmationSeconds: Math.round(r.avg_confirmation_seconds),
    sampleCount: r.sample_count,
  }));
}
