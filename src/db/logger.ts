/**
 * src/db/logger.ts — Structured activity log to SQLite
 *
 * Writes human-readable log entries to the agent_logs table so judges and
 * operators can see exactly what the bot has been doing — without SSH access.
 *
 * Usage:
 *   import { dbLog } from '../db/logger';
 *   dbLog('RELAY', 'info', 'Payment confirmed', { paymentId, amount });
 *   dbLog('AGENT', 'info', 'Board meeting complete', { toolCalls: 7, costUsd: 0.04 });
 *   dbLog('ANOMALY', 'warn', 'arb_eth_low detected', { ethBalance: 0.0008 });
 */

import { v4 as uuid } from 'uuid';
import { db } from './index';

export type LogLevel    = 'info' | 'warn' | 'error';
export type LogCategory =
  | 'RELAY'       // payment lifecycle events
  | 'CAPITAL'     // Aave, swaps, bridges
  | 'AGENT'       // board meetings, decision sessions, tool calls
  | 'ANOMALY'     // anomaly detections and responses
  | 'FEE'         // fee changes
  | 'EXPERIMENT'  // experiment create / evaluate
  | 'BRIDGE'      // cross-chain bridge status
  | 'SYSTEM';     // startup, shutdown, cron ticks

export interface LogEntry {
  id: string;
  created_at: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data: string | null; // JSON string or null
}

/**
 * Write a log entry to the database.
 *
 * This is intentionally synchronous (better-sqlite3 is synchronous) so it
 * can be called fire-and-forget anywhere without await.
 *
 * @param category  Broad area of the system (RELAY, CAPITAL, AGENT, …)
 * @param level     Severity: info | warn | error
 * @param message   Human-readable summary — keep to one line
 * @param data      Optional structured context (will be JSON.stringified)
 */
export function dbLog(
  category: LogCategory,
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  try {
    db.prepare(`
      INSERT INTO agent_logs (id, created_at, level, category, message, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      uuid(),
      new Date().toISOString(),
      level,
      category,
      message,
      data ? JSON.stringify(data) : null,
    );
  } catch (err) {
    // Logging must never crash the caller.
    console.error('[logger] Failed to write to agent_logs:', err);
  }
}

/**
 * Retrieve recent log entries, newest first.
 *
 * @param opts.category  Filter by category (optional)
 * @param opts.level     Filter by level (optional)
 * @param opts.since     Only return entries after this ISO timestamp (optional)
 * @param opts.limit     Max entries to return (default 100)
 */
export function getLogs(opts: {
  category?: LogCategory;
  level?: LogLevel;
  since?: string;
  limit?: number;
} = {}): LogEntry[] {
  const { category, level, since, limit = 100 } = opts;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  if (level) {
    conditions.push('level = ?');
    params.push(level);
  }
  if (since) {
    conditions.push('created_at > ?');
    params.push(since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT * FROM agent_logs
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit) as LogEntry[];
}
