/**
 * src/db/queries/experiments.ts — Experiment log queries
 *
 * The agent uses the scientific method to guide its decisions:
 *   1. Observe a situation.
 *   2. Form a hypothesis ("if I lower the fee to 0.25%, volume will increase
 *      and net revenue will be flat or higher within 7 days").
 *   3. Take an action (the experiment).
 *   4. Record the metric to watch and when to evaluate.
 *   5. On check_date, read the outcome and record what was learned.
 *
 * This module persists that log. The agent reads it at the start of every
 * board meeting for historical context.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../index';
import type { Experiment, ExperimentStatus } from '../schema';

export interface SaveExperimentParams {
  context: string;
  hypothesis: string;
  decision: string;
  metric: string;
  /** ISO date string — when the agent should evaluate this. */
  checkDate: string;
}

/**
 * saveExperiment — Insert a new experiment record.
 *
 * Called by the agent tool `save_experiment` (src/agent/tools/experiments.ts)
 * during a board meeting or decision session. The agent always records the
 * experiment *before* taking the action described in `decision`.
 */
export function saveExperiment(params: SaveExperimentParams): Experiment {
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO experiments
      (id, created_at, context, hypothesis, decision, metric, check_date, outcome, learning, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending')
  `).run(id, now, params.context, params.hypothesis, params.decision, params.metric, params.checkDate);

  return getExperimentById(id) as Experiment;
}

/**
 * getPendingExperiments — Return experiments whose evaluation date has passed.
 *
 * Called by the anomaly checker (src/monitoring/anomaly.ts) to surface
 * experiments that need the agent's attention. Only returns experiments
 * where check_date <= today AND status = 'pending'.
 */
export function getPendingExperiments(): Experiment[] {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return db.prepare(`
    SELECT * FROM experiments
    WHERE check_date <= ? AND status = 'pending'
    ORDER BY check_date ASC
  `).all(today) as Experiment[];
}

/**
 * updateExperiment — Record the outcome and learning from an evaluated experiment.
 *
 * Called by the agent tool `evaluate_experiment` after reading the relevant
 * metrics and forming a conclusion. The `learning` field is the agent's
 * distilled insight that should influence future decisions — it is written
 * to MEMORY.md as well.
 */
export function updateExperiment(
  id: string,
  outcome: string,
  learning: string,
): void {
  db.prepare(`
    UPDATE experiments
    SET outcome = ?, learning = ?, status = 'evaluated'
    WHERE id = ?
  `).run(outcome, learning, id);
}

/**
 * getAllExperiments — Fetch the full experiment log.
 *
 * Injected into the board meeting context so the agent has full historical
 * visibility. The result is ordered chronologically (oldest first) so the
 * agent sees the arc of its own decision history.
 */
export function getAllExperiments(status?: ExperimentStatus): Experiment[] {
  if (status) {
    return db.prepare(`
      SELECT * FROM experiments WHERE status = ? ORDER BY created_at ASC
    `).all(status) as Experiment[];
  }
  return db.prepare('SELECT * FROM experiments ORDER BY created_at ASC').all() as Experiment[];
}

/**
 * getExperimentById — Internal helper used after INSERT to return the full row.
 */
function getExperimentById(id: string): Experiment | null {
  const row = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id);
  return (row as Experiment) ?? null;
}
