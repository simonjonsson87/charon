/**
 * src/relay/addressPool.ts — HD address pool manager
 *
 * The address pool ensures there are always enough pre-derived TRON addresses
 * ready to assign to new payment requests without on-demand key derivation
 * causing latency in the hot path.
 *
 * Pool lifecycle:
 *   - On startup, ensurePoolSize() grows the pool to MIN_POOL_SIZE if needed.
 *   - When a payment is created, acquireAddress() assigns an available address.
 *   - When a payment completes (confirmed, expired, or failed), releaseAddress()
 *     returns the address to the pool for reuse.
 *   - If the pool is depleted (all addresses in_use), growPool() derives more.
 *
 * Address reuse policy:
 *   An address MUST NOT be assigned to two payments simultaneously — doing so
 *   would make it impossible to know which payment an incoming transfer belongs
 *   to. After forwarding is complete, the address is safe to reuse for a new
 *   payment because the old payment's record still exists in the DB for
 *   historical reference.
 *
 *   For extra privacy (not required for MVP), consider a "recycling" cooling
 *   period before an address is marked available again.
 */

import {
  getAddressFromPool,
  releaseAddress as dbReleaseAddress,
  ensurePoolSize as dbEnsurePoolSize,
} from '../db/queries/payments';
import { deriveAddress } from '../wallet/tron';
import type { AddressPoolEntry } from '../db/schema';

/** Minimum number of pre-derived addresses kept in the pool. */
const MIN_POOL_SIZE = 20;

/**
 * acquireAddress — Claim the next available address for a payment.
 *
 * Returns null if the pool is exhausted. Callers should call growPool()
 * and retry, or return an error to the API caller indicating the system
 * is temporarily at capacity.
 *
 * The address is marked in_use in the DB by getAddressFromPool() before
 * this function returns — no other concurrent call can claim the same address.
 * (SQLite's serialised write model makes this safe without additional locks.)
 */
export function acquireAddress(paymentId: string): AddressPoolEntry | null {
  const entry = getAddressFromPool();
  if (!entry) {
    console.warn('[address-pool] Pool exhausted — no available addresses.');
    return null;
  }

  // The payment_id link is set by createPayment() in the same transaction.
  // acquireAddress() just claims the slot; the full linkage happens in
  // db/queries/payments.ts createPayment().
  void paymentId; // used by createPayment to mark payment_id on the row
  return entry;
}

/**
 * releaseAddress — Return an address to the available pool.
 *
 * Called after:
 *   - A payment is forwarded successfully (confirmed → forwarded).
 *   - A payment expires without a detected transfer.
 *   - A payment permanently fails after forwarding errors.
 *
 * Not called while a payment is in 'detected' state — we must hold the
 * address until forwarding completes.
 */
export function releaseAddress(index: number): void {
  dbReleaseAddress(index);
  console.log(`[address-pool] Address index ${index} returned to pool.`);
}

/**
 * growPool — Derive additional HD addresses and add them to the pool.
 *
 * Called proactively when pool utilisation is high (e.g., > 80% in_use)
 * to avoid running out under burst load. Also called defensively when
 * acquireAddress() returns null.
 *
 * Logs a metric for monitoring purposes — pool growth indicates the agent
 * may be seeing higher-than-expected concurrent payment volume.
 */
export async function growPool(targetSize: number): Promise<void> {
  console.log(`[address-pool] Growing pool to ${targetSize} addresses...`);
  await dbEnsurePoolSize(targetSize, deriveAddress);
  console.log(`[address-pool] Pool growth complete. Target: ${targetSize}.`);
}

/**
 * ensureMinimumPool — Called at startup to prime the address pool.
 *
 * Idempotent: if the pool already has enough addresses, this is a no-op.
 */
export async function ensureMinimumPool(): Promise<void> {
  await growPool(MIN_POOL_SIZE);
}
