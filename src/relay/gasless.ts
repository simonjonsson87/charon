/**
 * src/relay/gasless.ts — Gasless sponsorship execution logic
 *
 * This module bridges the payment monitor and the gasless wallet module.
 * When the monitor detects an incoming payment, it calls sponsorIfNeeded()
 * here to check whether the recipient address can self-fund its USDT
 * transfer gas and, if not, sponsors energy on its behalf.
 *
 * Cost model recap:
 *   - At payment creation time, `amount_due` already includes a gas
 *     sponsorship estimate computed by estimateEnergyCost().
 *   - This module executes the actual sponsorship at confirmation time.
 *   - Any delta between the estimate and actual cost is absorbed by the
 *     relay margin. The delta is expected to be small (<5% on average).
 *
 * Why sponsor at detection (not confirmation):
 *   Energy rental from providers like TronSave is time-limited (typically
 *   10 minutes). We sponsor at detection so the energy is available when
 *   the confirmed transfer executes. If the energy expires before the
 *   transfer confirms (unlikely on TRON's 3s blocks), the system logs a
 *   warning and re-sponsors.
 */

import { checkNeedsSponsorship, sponsorEnergy, activateIfNeeded } from '../wallet/tronGasfree';

export interface SponsorshipResult {
  needed: boolean;
  success: boolean;
  trxCost: string;
  paymentId: string;
}

/**
 * checkNeedsSponsorshipForPayment — Check if a payment address needs energy.
 *
 * Thin wrapper around the wallet module that adds logging context.
 */
export async function checkNeedsEnergySponsorship(address: string): Promise<boolean> {
  const needed = await checkNeedsSponsorship(address);
  console.log(`[gasless] Address ${address} needs sponsorship: ${needed}`);
  return needed;
}

/**
 * sponsorIfNeeded — Check and sponsor energy for a payment address in one step.
 *
 * Called by the monitor loop immediately after detecting an incoming transfer.
 * If the address already has sufficient TRX energy (rare but possible for
 * power users), no sponsorship is performed and cost is zero.
 *
 * Records the TRX cost against the paymentId for accounting purposes.
 * TODO: persist sponsorship cost to the payments table or a separate
 * costs table for accurate P&L accounting.
 */
export async function sponsorIfNeeded(
  address: string,
  paymentId: string,
): Promise<SponsorshipResult> {
  // Ensure the address is activated before attempting energy sponsorship.
  // Unactivated addresses cannot broadcast transactions; activation requires
  // at least one inbound TRX transfer to create the account on-chain.
  await activateIfNeeded(address);

  const needed = await checkNeedsSponsorship(address);

  if (!needed) {
    return { needed: false, success: true, trxCost: '0', paymentId };
  }

  console.log(`[gasless] Sponsoring energy for payment ${paymentId} at address ${address}`);

  const result = await sponsorEnergy(address);

  if (result.success) {
    console.log(
      `[gasless] Sponsorship successful for ${paymentId}. TRX cost: ${result.trxCost}`,
    );
  } else {
    console.error(`[gasless] Sponsorship failed for ${paymentId}. Forwarding may fail.`);
  }

  return {
    needed: true,
    success: result.success,
    trxCost: result.trxCost,
    paymentId,
  };
}

/**
 * calculateSponsorshipCost — Estimate the TRX cost to sponsor a USDT transfer.
 *
 * Called at payment creation time to include gas cost in amount_due.
 * The estimate uses the current best-price provider from the energy
 * intelligence cache. Returns a decimal TRX string.
 *
 * Note: this is an estimate. Actual cost may differ by a few percent depending
 * on energy market conditions at execution time.
 */
export async function calculateSponsorshipCost(_address: string): Promise<string> {
  // At payment creation time the sender's address is unknown, so we conservatively
  // assume sponsorship will be needed. The real per-address check happens at
  // execution time in sponsorIfNeeded().
  const { estimateEnergyCost } = await import('../wallet/tronGasfree');
  return estimateEnergyCost('usdt_transfer');
}
