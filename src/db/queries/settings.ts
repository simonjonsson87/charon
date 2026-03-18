/**
 * src/db/queries/settings.ts — Persisted key-value settings
 *
 * A thin wrapper around the `settings` table for storing runtime configuration
 * that must survive process restarts. The primary use case is the relay fee
 * percentage, which the agent can update at runtime and which must not revert
 * to the env-var default after a restart.
 *
 * All values are stored as TEXT. Callers are responsible for parsing
 * (e.g., parseFloat for numeric settings).
 *
 * Usage:
 *   import { getSetting, setSetting, SETTING_KEYS } from './settings';
 *
 *   const fee = getSetting(SETTING_KEYS.RELAY_FEE_PERCENT);
 *   setSetting(SETTING_KEYS.RELAY_FEE_PERCENT, '0.25');
 */

import { db } from '../index';
import { SETTING_KEYS } from '../schema';

export { SETTING_KEYS };

/**
 * getSetting — Retrieve a persisted setting value.
 *
 * Returns null if the key has never been set (first run, or key not yet
 * written). Callers should fall back to the env-var default in that case.
 */
export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;

  return row?.value ?? null;
}

/**
 * setSetting — Persist a setting value.
 *
 * Uses INSERT OR REPLACE so the call is idempotent — safe to call repeatedly
 * with the same key. `updated_at` is always set to the current timestamp.
 */
export function setSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value      = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, new Date().toISOString());
}

/**
 * getSettingAsFloat — Convenience wrapper for numeric settings.
 *
 * Returns the DB value as a float, or `defaultValue` if the setting is
 * not yet persisted.
 */
export function getSettingAsFloat(key: string, defaultValue: number): number {
  const raw = getSetting(key);
  if (raw === null) return defaultValue;

  const parsed = parseFloat(raw);
  if (isNaN(parsed)) {
    console.warn(`[settings] Invalid float value for key "${key}": "${raw}". Using default ${defaultValue}.`);
    return defaultValue;
  }

  return parsed;
}
