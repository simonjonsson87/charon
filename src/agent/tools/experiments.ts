/**
 * src/agent/tools/experiments.ts — Agent tools: experiment management
 *
 * These functions are registered as tools in the relay-ops skill.
 * The agent calls these to read, create, and evaluate experiments during
 * board meetings and decision sessions.
 *
 * The experiment loop is central to how the agent learns:
 *   1. Agent observes a metric or situation.
 *   2. Agent forms a hypothesis (saveExperiment).
 *   3. Agent takes an action (e.g., updates the fee).
 *   4. On check_date, agent reads metrics and evaluates the outcome (evaluateExperiment).
 *   5. Learning is recorded and informs future decisions.
 *
 * These tools are thin DB wrappers. The reasoning about WHAT to experiment on
 * and HOW to interpret results lives in the agent's instructions (AGENTS.md).
 */

import {
  saveExperiment as dbSaveExperiment,
  getPendingExperiments as dbGetPendingExperiments,
  updateExperiment as dbUpdateExperiment,
  getAllExperiments as dbGetAllExperiments,
} from '../../db/queries/experiments';
import type { Experiment, ExperimentStatus } from '../../db/schema';
import type { SaveExperimentParams } from '../../db/queries/experiments';

// ---------------------------------------------------------------------------
// Tool: get_experiments
// ---------------------------------------------------------------------------

/**
 * getExperiments — Return the experiment log filtered by status.
 *
 * Called by the agent as `get_experiments`. When called with no status filter,
 * returns the full history. The agent typically reads this at the start of
 * a board meeting to review past decisions.
 *
 * The last 20 experiments are usually sufficient for decision-making context.
 * Pass `limit` to control how many are returned.
 */
export function getExperiments(
  status?: ExperimentStatus,
  limit: number = 20,
): Experiment[] {
  const all = dbGetAllExperiments(status);
  // Return most recent first for LLM context relevance.
  return all.slice(-limit).reverse();
}

/**
 * getPendingExperiments — Return experiments due for evaluation.
 *
 * Convenience wrapper for the anomaly checker.
 */
export function getPendingExperimentsForEvaluation(): Experiment[] {
  return dbGetPendingExperiments();
}

// ---------------------------------------------------------------------------
// Tool: save_experiment
// ---------------------------------------------------------------------------

/**
 * saveExperiment — Create a new experiment record.
 *
 * Called by the agent as `save_experiment` BEFORE taking the action described
 * in `decision`. This sequence is enforced by the agent's instructions but
 * cannot be enforced programmatically — the agent is trusted to follow the
 * procedure defined in AGENTS.md.
 *
 * The `checkDate` should be set to a meaningful future date — not too soon
 * (give the experiment time to produce signal) and not too far (feedback
 * loops should be tight). 7 days is a reasonable default for fee experiments.
 */
export function saveExperiment(params: {
  context: string;
  hypothesis: string;
  decision: string;
  metric: string;
  checkDate: string; // YYYY-MM-DD
}): Experiment {
  // Validate that checkDate is in the future.
  const today = new Date().toISOString().split('T')[0]!;
  if (params.checkDate <= today) {
    throw new Error(
      `Experiment checkDate (${params.checkDate}) must be in the future (today is ${today}).`,
    );
  }

  const saved = dbSaveExperiment(params as SaveExperimentParams);
  console.log(`[tools/experiments] New experiment created: ${saved.id}`);
  return saved;
}

// ---------------------------------------------------------------------------
// Tool: evaluate_experiment
// ---------------------------------------------------------------------------

/**
 * evaluateExperiment — Record the outcome and learning from a completed experiment.
 *
 * Called by the agent as `evaluate_experiment` when processing pending
 * experiments during a board meeting or decision session.
 *
 * The `outcome` should describe what actually happened (measurable).
 * The `learning` should describe what this implies for future decisions.
 *
 * Example:
 *   outcome: "Revenue per transaction dropped 8% but transaction count increased 15%.
 *             Net USDT revenue increased 6% vs. the week before the fee change."
 *   learning: "Fee elasticity is present: a 0.1% fee reduction increases volume
 *              enough to improve net revenue at current transaction sizes."
 */
export function evaluateExperiment(
  id: string,
  outcome: string,
  learning: string,
): void {
  if (!outcome.trim()) throw new Error('outcome cannot be empty');
  if (!learning.trim()) throw new Error('learning cannot be empty');

  dbUpdateExperiment(id, outcome, learning);
  console.log(`[tools/experiments] Experiment ${id} evaluated.`);
}
