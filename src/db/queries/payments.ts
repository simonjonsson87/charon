/**
 * src/db/queries/payments.ts — Payment and address pool queries
 *
 * All SQL lives here. The rest of the codebase imports named functions;
 * raw SQL strings never leak out of this module.
 *
 * Conventions:
 *   - Functions that write use db.transaction() so partial failures roll back.
 *   - Monetary amounts are passed and returned as strings. Never convert to
 *     Number before storing — floating-point precision loss would affect fees.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../index';
import type { Payment, PaymentStatus, AddressPoolEntry } from '../schema';

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface CreatePaymentParams {
  developerId: string;
  orderId: string;
  address: string;
  addressIndex: number;
  amountDue: string;
  amountNet: string;
  expiresAt: string; // ISO-8601
}

/**
 * createPayment — Insert a new payment record and mark the address as in_use.
 *
 * Both writes are wrapped in a transaction so we never end up with an orphaned
 * payment pointing at an address that wasn't marked in_use, or vice versa.
 */
export function createPayment(params: CreatePaymentParams): Payment {
  const id = uuidv4();
  const now = new Date().toISOString();

  const insert = db.transaction(() => {
    db.prepare(`
      INSERT INTO payments
        (id, developer_id, order_id, address, address_index,
         amount_due, amount_net, currency, status,
         tx_hash, confirmations, created_at, detected_at, confirmed_at, expires_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, 'USDT', 'pending',
         NULL, 0, ?, NULL, NULL, ?)
    `).run(
      id,
      params.developerId,
      params.orderId,
      params.address,
      params.addressIndex,
      params.amountDue,
      params.amountNet,
      now,
      params.expiresAt,
    );

    // Mark the address as in_use so no other payment can claim it.
    db.prepare(`
      UPDATE address_pool
      SET status = 'in_use', payment_id = ?, last_used_at = ?
      WHERE idx = ?
    `).run(id, now, params.addressIndex);
  });

  insert();

  return getPayment(id) as Payment;
}

/**
 * getPayment — Fetch a single payment by its UUID.
 * Returns null if not found.
 */
export function getPayment(id: string): Payment | null {
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  return (row as Payment) ?? null;
}

/**
 * updatePaymentStatus — Transition a payment's state machine.
 *
 * Called by the monitor loop as confirmations accumulate.
 * `txHash` and `confirmations` are optional — only supplied when transitioning
 * to 'detected' or 'confirmed'.
 *
 * Timestamps are set automatically based on the target status:
 *   - 'detected'  → detected_at is set (once; COALESCE prevents overwriting)
 *   - 'confirmed' → confirmed_at is set
 */
export function updatePaymentStatus(
  id: string,
  status: PaymentStatus,
  txHash?: string,
  confirmations?: number,
): void {
  const now = new Date().toISOString();
  // Set the appropriate timestamp based on the transition.
  const detectedAt  = status === 'detected'  ? now : null;
  const confirmedAt = status === 'confirmed' ? now : null;

  db.prepare(`
    UPDATE payments
    SET status        = ?,
        tx_hash       = COALESCE(?, tx_hash),
        confirmations = COALESCE(?, confirmations),
        detected_at   = COALESCE(detected_at, ?),
        confirmed_at  = COALESCE(?, confirmed_at)
    WHERE id = ?
  `).run(status, txHash ?? null, confirmations ?? null, detectedAt, confirmedAt, id);
}

/**
 * getActivePayments — All payments the monitor loop needs to watch.
 *
 * Returns pending and detected payments. Confirmed, expired, and failed
 * payments are not returned — the monitor has nothing to do with them.
 */
export function getActivePayments(): Payment[] {
  return db.prepare(`
    SELECT * FROM payments
    WHERE status IN ('pending', 'detected', 'bridging')
    ORDER BY created_at ASC
  `).all() as Payment[];
}

/**
 * expireOldPayments — Mark stale pending payments as expired and release their addresses.
 *
 * Called by the scheduler every minute. A payment is expired if:
 *   - status is 'pending' (not yet detected), AND
 *   - expires_at < now
 *
 * Detected payments are NOT expired here — if USDT has arrived on-chain we
 * should still try to confirm and forward it even if the deadline has passed.
 * That edge case is handled manually / by the board meeting agent.
 */
export function expireOldPayments(): number {
  const now = new Date().toISOString();

  const expire = db.transaction(() => {
    // Fetch IDs and address indexes before updating so we can release addresses.
    const toExpire = db.prepare(`
      SELECT id, address_index FROM payments
      WHERE status = 'pending' AND expires_at < ?
    `).all(now) as { id: string; address_index: number }[];

    if (toExpire.length === 0) return 0;

    for (const row of toExpire) {
      db.prepare(`UPDATE payments SET status = 'expired' WHERE id = ?`).run(row.id);
      releaseAddress(row.address_index);
    }

    return toExpire.length;
  });

  return expire() as number;
}

// ---------------------------------------------------------------------------
// Address pool
// ---------------------------------------------------------------------------

/**
 * getAddressFromPool — Find the next available address and mark it in_use.
 *
 * Returns the address entry or null if the pool is depleted (caller should
 * trigger growPool() and retry). The address is optimistically marked
 * in_use before the payment record exists — createPayment() then links
 * the payment_id. If createPayment() fails, the caller must call
 * releaseAddress() to prevent the address from being stranded.
 */
export function getAddressFromPool(): AddressPoolEntry | null {
  const row = db.prepare(`
    SELECT * FROM address_pool
    WHERE status = 'available'
    ORDER BY idx ASC
    LIMIT 1
  `).get() as AddressPoolEntry | undefined;

  if (!row) return null;

  db.prepare(`
    UPDATE address_pool SET status = 'in_use', last_used_at = ?
    WHERE idx = ?
  `).run(new Date().toISOString(), row.idx);

  return row;
}

/**
 * releaseAddress — Return an address to the available pool.
 *
 * Called after a payment is confirmed+forwarded, expired, or failed.
 * The address is safe to reuse at this point — TRON addresses can receive
 * multiple payments sequentially as long as we don't assign two payments to
 * the same address simultaneously.
 */
export function releaseAddress(index: number): void {
  db.prepare(`
    UPDATE address_pool
    SET status = 'available', payment_id = NULL
    WHERE idx = ?
  `).run(index);
}

/**
 * ensurePoolSize — Grow the address pool to at least `targetSize` entries.
 *
 * `deriveAddress` is injected as a callback to avoid a circular import
 * (wallet/tron.ts → db/queries/payments.ts would be circular if wallet
 * imported from here). The callback receives the HD derivation index and
 * returns the corresponding TRON address string.
 *
 * Only derives addresses that don't already exist in the pool — safe to
 * call on every startup.
 */
export async function ensurePoolSize(
  targetSize: number,
  deriveAddress: (index: number) => Promise<string>,
  startIndex = 3,
): Promise<void> {
  // Remove any available pool entries below startIndex — those indices are
  // reserved for the agent's own operational wallets (hot wallet, gas wallet, etc.)
  // and must never be handed out as payment deposit addresses.
  db.prepare(`DELETE FROM address_pool WHERE idx < ? AND status = 'available'`).run(startIndex);

  // Count how many usable pool entries (idx >= startIndex) already exist.
  const existing = (db.prepare(
    'SELECT COUNT(*) as count FROM address_pool WHERE idx >= ?'
  ).get(startIndex) as { count: number }).count;

  if (existing >= targetSize) return;

  // Derive indices from startIndex upward, skipping ones already in the pool.
  const inPool = new Set<number>(
    (db.prepare('SELECT idx FROM address_pool WHERE idx >= ?').all(startIndex) as { idx: number }[])
      .map(r => r.idx)
  );

  console.log(`[address-pool] Growing pool from ${existing} to ${targetSize} addresses (start index ${startIndex})...`);

  let added = existing;
  for (let i = startIndex; added < targetSize; i++) {
    if (inPool.has(i)) continue;
    const address = await deriveAddress(i);
    db.prepare(`
      INSERT OR IGNORE INTO address_pool (idx, address, status, payment_id, last_used_at)
      VALUES (?, ?, 'available', NULL, NULL)
    `).run(i, address);
    added++;
  }

  console.log(`[address-pool] Pool now has ${targetSize} addresses (indices ${startIndex}+).`);
}
