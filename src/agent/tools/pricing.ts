/**
 * src/agent/tools/pricing.ts — Agent tool: update_fee
 *
 * This module allows the agent to adjust the relay fee percentage at runtime.
 * Fee changes take effect immediately for new payment requests; existing
 * pending payments use the fee at the time of creation.
 *
 * Design constraints (enforced by instructions in AGENTS.md, not code):
 *   - The agent MUST create an experiment before calling update_fee.
 *   - The agent MUST NOT change the fee by more than 0.2% in a single step
 *     without evidence from a prior experiment (see AGENTS.md constraints).
 *   - Fee changes are always logged for audit purposes.
 *
 * Fee persistence:
 *   Fee changes are written to the `settings` table so they survive process
 *   restarts. On startup, payment.ts reads the persisted fee from the DB
 *   before falling back to the RELAY_FEE_PERCENT env var.
 */

import { runtimeConfig } from '../../server/routes/payment';
import { setSetting, SETTING_KEYS } from '../../db/queries/settings';

export interface FeeChangeRecord {
  previousFeePercent: number;
  newFeePercent: number;
  reason: string;
  changedAt: string;
}

/** In-memory log of fee changes for the current session. */
const feeChangeLog: FeeChangeRecord[] = [];

/**
 * updateFee — Change the relay fee percentage.
 *
 * Called by the agent as `update_fee`. The change takes effect immediately
 * for all new payment.create requests.
 *
 * @param newPercent — The new fee as a percentage (e.g., 0.25 for 0.25%).
 * @param reason — Human-readable reason for the change, logged for audit.
 *
 * Constraints checked here (soft guards — the agent's instructions are the
 * primary enforcement mechanism):
 *   - Fee must be between 0.1% and 2.0%.
 *   - Single-step change must not exceed 0.5% (hard ceiling here; AGENTS.md
 *     recommends 0.2% without evidence).
 */
export function updateFee(newPercent: number, reason: string): FeeChangeRecord {
  const previous = runtimeConfig.relayFeePercent;

  // Hard bounds.
  if (newPercent < 0.1 || newPercent > 2.0) {
    throw new Error(
      `Fee ${newPercent}% is out of bounds. Must be between 0.1% and 2.0%.`,
    );
  }

  // Maximum single-step change.
  const delta = Math.abs(newPercent - previous);
  if (delta > 0.5) {
    throw new Error(
      `Fee change of ${delta.toFixed(2)}% exceeds the maximum single-step change of 0.5%.`,
    );
  }

  runtimeConfig.relayFeePercent = newPercent;

  // Persist to DB so the fee survives process restarts without requiring the
  // agent to re-establish it through a board meeting.
  setSetting(SETTING_KEYS.RELAY_FEE_PERCENT, newPercent.toString());

  const record: FeeChangeRecord = {
    previousFeePercent: previous,
    newFeePercent: newPercent,
    reason,
    changedAt: new Date().toISOString(),
  };

  feeChangeLog.push(record);

  console.log(
    `[tools/pricing] Fee updated: ${previous}% → ${newPercent}%. Reason: ${reason}`,
  );

  return record;
}

/**
 * getCurrentFee — Return the current runtime fee.
 *
 * Called by the agent to confirm the current fee before deciding to change it.
 */
export function getCurrentFee(): { feePercent: number; changesSinceStart: number } {
  return {
    feePercent: runtimeConfig.relayFeePercent,
    changesSinceStart: feeChangeLog.length,
  };
}

/**
 * getFeeHistory — Return the log of fee changes in this session.
 *
 * Useful for the agent to see recent pricing history when evaluating
 * the effect of past fee changes.
 */
export function getFeeHistory(): FeeChangeRecord[] {
  return [...feeChangeLog];
}
