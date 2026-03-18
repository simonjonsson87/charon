/**
 * src/db/queries/developers.ts — Developer account queries
 *
 * Developers register once and receive an API key. Every subsequent request
 * is authenticated by that key (see server/middleware/auth.ts).
 *
 * The API key is a 32-byte cryptographically random hex string generated here
 * at registration time. It is stored in plaintext in the DB (not hashed)
 * because the server needs to look up developers by key on every request.
 * This is acceptable for an MVP; production should hash keys and use a
 * timing-safe compare.
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../index';
import type { Developer } from '../schema';

export interface RegisterDeveloperParams {
  receivingAddress: string; // TRON TRC-20 address (always required — used as the sweep source)
  webhookUrl: string;
  webhookSecret: string;
  /** Payout destination chain. Defaults to 'tron'. */
  payoutChain?: 'tron' | 'base';
  /** Required when payoutChain = 'base'. The developer's Base address for USDC payout. */
  baseReceivingAddress?: string;
}

export interface RegisterDeveloperResult {
  developer: Developer;
  /** The raw API key — only returned once at registration. Developer must store it. */
  apiKey: string;
}

/**
 * registerDeveloper — Create a new developer account.
 *
 * Generates a random 32-byte API key and returns it alongside the new
 * developer record. The key is shown to the developer exactly once; the
 * server cannot recover it for them (they must re-register for a new key).
 */
export function registerDeveloper(params: RegisterDeveloperParams): RegisterDeveloperResult {
  const id = uuidv4();
  // 32 bytes = 64 hex chars. crypto.randomBytes is CSPRNG — safe for API keys.
  const apiKey = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();

  const payoutChain = params.payoutChain ?? 'tron';
  const baseAddr = params.baseReceivingAddress ?? null;

  db.prepare(`
    INSERT INTO developers
      (id, api_key, receiving_address, payout_chain, base_receiving_address,
       webhook_url, webhook_secret, created_at, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id, apiKey, params.receivingAddress, payoutChain, baseAddr,
    params.webhookUrl, params.webhookSecret, now,
  );

  const developer = getDeveloperById(id) as Developer;
  return { developer, apiKey };
}

/**
 * getDeveloperByApiKey — Look up a developer by their API key.
 *
 * Used on every authenticated request. The query hits the UNIQUE index on
 * api_key so it is O(log n) — fast enough to run on every request without
 * caching (developer count is expected to be small).
 *
 * Returns null for unknown keys. Returns null (not the record) for inactive
 * developers so callers don't need to check the is_active flag separately.
 *
 * TODO: add timing-safe compare to resist timing attacks if this becomes
 * externally exposed at scale.
 */
export function getDeveloperByApiKey(apiKey: string): Developer | null {
  const row = db.prepare(`
    SELECT * FROM developers WHERE api_key = ? AND is_active = 1
  `).get(apiKey);

  return (row as Developer) ?? null;
}

/**
 * getDeveloperById — Fetch a developer by their UUID.
 *
 * Used internally (e.g. webhook delivery looks up the developer after
 * confirming a payment).
 */
export function getDeveloperById(id: string): Developer | null {
  const row = db.prepare('SELECT * FROM developers WHERE id = ?').get(id);
  return (row as Developer) ?? null;
}

/**
 * deactivateDeveloper — Soft-delete a developer account.
 *
 * Existing payments for this developer continue to process normally.
 * New payment creation requests will be rejected because getDeveloperByApiKey
 * filters out inactive developers.
 *
 * TODO: expose this via an admin endpoint protected by a separate master key.
 */
export function deactivateDeveloper(id: string): void {
  db.prepare('UPDATE developers SET is_active = 0 WHERE id = ?').run(id);
}
