/**
 * src/db/index.ts — SQLite connection singleton
 *
 * Opens a better-sqlite3 database at the path specified by SQLITE_PATH and
 * runs all CREATE TABLE IF NOT EXISTS migrations on first boot.
 *
 * Design notes:
 *   - WAL (Write-Ahead Logging) mode is enabled so the monitor loop's reads
 *     do not block writes from the HTTP request handlers and vice versa.
 *     WAL is safe for a single-process deployment (which this is).
 *   - The `db` export is a module-level singleton. Importing this module from
 *     multiple files is safe — Node.js caches the module after the first load,
 *     so only one connection is ever opened.
 *   - `closeDb()` is exported for use during graceful shutdown (src/index.ts).
 */

import Database, { type Database as BetterSqliteDb } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { ALL_SCHEMA_STATEMENTS } from './schema';

// Resolve the DB path from env, defaulting to ./data/agent.db.
const dbPath = path.resolve(process.env.SQLITE_PATH ?? './data/agent.db');

// Ensure the parent directory exists before better-sqlite3 tries to open the file.
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Open the database. The `verbose` option pipes every executed SQL statement
// to console.debug — useful during development; comment out in production.
export const db: BetterSqliteDb = new Database(dbPath, {
  // verbose: console.debug,
});

/**
 * initDb — Run all schema migrations.
 *
 * Called once at startup (src/index.ts). All statements are idempotent
 * (CREATE TABLE IF NOT EXISTS), so re-running is safe after upgrades.
 * For real schema migrations (ALTER TABLE, etc.) a dedicated migration
 * library (e.g. db-migrate, umzug) should be introduced here.
 */
export function initDb(): void {
  // Enable WAL mode for concurrent-friendly reads during the monitor polling loop.
  db.pragma('journal_mode = WAL');

  // Enable foreign key enforcement — SQLite disables this by default.
  db.pragma('foreign_keys = ON');

  // Run all CREATE TABLE statements in a single transaction for atomicity.
  const migrate = db.transaction(() => {
    for (const statement of ALL_SCHEMA_STATEMENTS) {
      db.prepare(statement).run();
    }
  });

  migrate();
  console.log('[db] Schema migrations applied.');
}

/**
 * closeDb — Close the database connection.
 *
 * Called during graceful shutdown. better-sqlite3 is synchronous so there
 * are no in-flight async operations to wait for — closing is instantaneous.
 */
export function closeDb(): void {
  db.close();
  console.log('[db] Connection closed.');
}
