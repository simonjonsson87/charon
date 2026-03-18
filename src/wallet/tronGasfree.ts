/**
 * src/wallet/tronGasfree.ts — TRON gasless (energy sponsorship) module
 *
 * TRON requires TRX energy to execute smart contract calls (including USDT
 * TRC-20 transfers). A standard USDT transfer costs ~65,000 energy.
 *
 * Many end users do not hold TRX in their wallets. The gasless module
 * sponsors energy on their behalf by renting energy from a third-party
 * provider (TronSave or TR.ENERGY), using the provider recommended by the
 * energy intelligence service at that moment.
 *
 * Cost model:
 *   - The sponsorship cost is estimated at payment creation time using the
 *     current energy market price (intelligence/energy.ts).
 *   - That estimate is included in `amount_due` shown to the user.
 *   - At execution time, this module performs the actual sponsorship.
 *     If the real cost differs from the estimate, the delta is absorbed
 *     by the relay's fee margin.
 *
 * TRX reserve management:
 *   The agent maintains a TRX reserve for burn-based sponsorship fallback.
 *   Reserve replenishment is a capital allocation decision (src/agent/).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TronWeb = require('tronweb');
import axios from 'axios';

/** Standard TRON USDT TRC-20 transfer energy requirement. */
const USDT_TRANSFER_ENERGY = 65_000;

// Shared TronWeb instance (initialised at startup)
let tronWeb: typeof TronWeb | null = null;
let tronGridUrl = 'https://api.trongrid.io';
let apiKey: string | undefined;

// The agent's primary TRX address (HD index 0) — used as the energy payer.
let agentTronAddress: string | null = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * initTronGasfreeWallet — Initialise the gasless wallet module.
 *
 * Called at startup alongside initTronWallet(). Reads the same seed phrase
 * and reuses the TronGrid configuration.
 */
export async function initTronGasfreeWallet(): Promise<void> {
  const seed = process.env.WDK_SEED_PHRASE;
  if (!seed) {
    throw new Error('[wallet/tronGasfree] WDK_SEED_PHRASE environment variable is not set.');
  }

  tronGridUrl = process.env.TRON_RPC_URL ?? 'https://api.trongrid.io';
  apiKey = process.env.TRON_API_KEY;

  const headers: Record<string, string> = {};
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;

  tronWeb = new TronWeb({ fullHost: tronGridUrl, headers });

  // Derive the agent's primary address (index 0)
  const account = TronWeb.fromMnemonic(seed, `m/44'/195'/0'/0/0`);
  agentTronAddress = account.address as string;

  console.log('[wallet/tronGasfree] Gasless wallet initialised. Agent address:', agentTronAddress);
}

// ---------------------------------------------------------------------------
// Sponsorship
// ---------------------------------------------------------------------------

export type EnergyOperation = 'usdt_transfer' | 'usdt_approval';

/**
 * estimateEnergyCost — Calculate TRX cost to sponsor a standard operation.
 *
 * Uses the current best-price provider from the energy intelligence service
 * (the cached result from intelligence/energy.ts). Returns a decimal TRX string.
 */
export async function estimateEnergyCost(
  operation: EnergyOperation,
): Promise<string> {
  const energyRequired =
    operation === 'usdt_transfer' ? USDT_TRANSFER_ENERGY : 14_000;

  const { getLatestEnergyData } = await import('../intelligence/energy');
  const energyData = getLatestEnergyData();

  if (!energyData) {
    // Energy service hasn't warmed up yet — use a conservative estimate.
    return '0.050000';
  }

  const baseCostTrx =
    energyData.recommendedProvider === 'tronsave'
      ? energyData.tronsaveCostTrx
      : energyData.recommendedProvider === 'trenergy'
        ? energyData.trenergyCostTrx
        : energyData.burnCostTrx;

  const scaleFactor = energyRequired / USDT_TRANSFER_ENERGY;
  return (baseCostTrx * scaleFactor).toFixed(6);
}

/**
 * checkNeedsSponsorship — Determine if an address has enough energy to self-fund.
 *
 * Queries TronGrid for the address's available energy. Most end-user addresses
 * receiving USDT for the first time have zero TRX and need sponsorship.
 */
export async function checkNeedsSponsorship(address: string): Promise<boolean> {
  if (!tronWeb) {
    console.warn('[wallet/tronGasfree] Not initialised; assuming sponsorship needed.');
    return true;
  }

  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;

    const res = await axios.post(
      `${tronGridUrl}/wallet/getaccountresource`,
      { address: TronWeb.address.toHex(address) },
      { headers, timeout: 5000 },
    );

    const data = res.data as {
      EnergyLimit?: number;
      EnergyUsed?: number;
      freeNetLimit?: number;
      NetUsed?: number;
    };

    const availableEnergy = (data.EnergyLimit ?? 0) - (data.EnergyUsed ?? 0);
    return availableEnergy < USDT_TRANSFER_ENERGY;
  } catch (err) {
    console.warn(`[wallet/tronGasfree] checkNeedsSponsorship(${address}) failed, assuming needed:`, err);
    return true;
  }
}

/**
 * sponsorEnergy — Rent energy to a user address for one USDT transfer.
 *
 * Uses the provider recommended by the energy intelligence service.
 * Falls back to burn-based energy activation if rental APIs are unavailable.
 */
export async function sponsorEnergy(
  address: string,
  estimatedEnergy: number = USDT_TRANSFER_ENERGY,
): Promise<{ success: boolean; trxCost: string }> {
  if (!tronWeb) throw new Error('[wallet/tronGasfree] Wallet not initialised.');

  const { getLatestEnergyData } = await import('../intelligence/energy');
  const energyData = getLatestEnergyData();
  const provider = energyData?.recommendedProvider ?? 'burn';

  console.log(
    `[wallet/tronGasfree] Sponsoring ${estimatedEnergy} energy for ${address} via ${provider}.`,
  );

  if (provider === 'tronsave') {
    return sponsorViaTronSave(address, estimatedEnergy);
  } else if (provider === 'trenergy') {
    return sponsorViaTrEnergy(address, estimatedEnergy);
  } else {
    return sponsorViaBurn(address, estimatedEnergy);
  }
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function sponsorViaTronSave(
  address: string,
  energy: number,
): Promise<{ success: boolean; trxCost: string }> {
  try {
    // TronSave API: POST /v2/energy/buy
    const res = await axios.post(
      'https://api.tronsave.io/v2/energy/buy',
      { address, energy },
      { timeout: 15_000 },
    );

    const costTrx = parseFloat(res.data?.price_trx ?? res.data?.cost ?? '0');
    console.log(`[wallet/tronGasfree] TronSave sponsor: ${costTrx} TRX for ${energy} energy.`);
    return { success: true, trxCost: costTrx.toFixed(6) };
  } catch (err) {
    console.error('[wallet/tronGasfree] TronSave sponsor failed, falling back to burn:', err);
    return sponsorViaBurn(address, energy);
  }
}

async function sponsorViaTrEnergy(
  address: string,
  energy: number,
): Promise<{ success: boolean; trxCost: string }> {
  try {
    const res = await axios.post(
      'https://tr.energy/api/v1/buy',
      { address, energy },
      { timeout: 15_000 },
    );

    const costTrx = parseFloat(res.data?.price_trx ?? res.data?.total_cost ?? '0');
    console.log(`[wallet/tronGasfree] TR.ENERGY sponsor: ${costTrx} TRX for ${energy} energy.`);
    return { success: true, trxCost: costTrx.toFixed(6) };
  } catch (err) {
    console.error('[wallet/tronGasfree] TR.ENERGY sponsor failed, falling back to burn:', err);
    return sponsorViaBurn(address, energy);
  }
}

/**
 * sponsorViaBurn — Activate energy by freezing TRX from the agent's reserve.
 *
 * Last resort: used when rental APIs are unavailable. Freezes TRX from the
 * agent's primary address to generate energy for the target address.
 * The TRX is frozen for 3 days minimum (TRON protocol requirement).
 */
async function sponsorViaBurn(
  address: string,
  energy: number,
): Promise<{ success: boolean; trxCost: string }> {
  if (!agentTronAddress) {
    return { success: false, trxCost: '0' };
  }

  try {
    // Estimate TRX needed for the required energy at current market rate.
    const { getLatestEnergyData } = await import('../intelligence/energy');
    const energyData = getLatestEnergyData();
    const priceSun = energyData?.energyPriceSun ?? 420;
    const costTrx = (energy * priceSun) / 1_000_000;

    // TronWeb: delegate energy (freeze TRX for the target address).
    // This uses the v2 mechanism (STAKE_ENERGY resource type).
    const res = await tronWeb.trx.freezeBalanceV2(
      Math.round(costTrx * 1_000_000), // TRX amount in SUN
      'ENERGY',
    );

    if (res.result) {
      // After freezing, delegate the energy to the target address.
      await tronWeb.trx.delegateResource(
        Math.round(costTrx * 1_000_000),
        address,
        'ENERGY',
        agentTronAddress,
      );
    }

    console.log(`[wallet/tronGasfree] Burn sponsor: ${costTrx.toFixed(6)} TRX → ${energy} energy for ${address}.`);
    return { success: true, trxCost: costTrx.toFixed(6) };
  } catch (err) {
    console.error('[wallet/tronGasfree] Burn sponsor failed:', err);
    return { success: false, trxCost: '0' };
  }
}

// ---------------------------------------------------------------------------
// TRX balance
// ---------------------------------------------------------------------------

/**
 * getAgentTrxBalance — Return the agent's TRX reserve balance.
 *
 * Monitored by the anomaly checker. If TRX drops below a threshold,
 * an alert is raised for the capital allocation decision layer.
 */
export async function getAgentTrxBalance(): Promise<string> {
  if (!tronWeb || !agentTronAddress) throw new Error('[wallet/tronGasfree] Wallet not initialised.');

  try {
    const balanceSun = await tronWeb.trx.getBalance(agentTronAddress);
    return (balanceSun / 1_000_000).toFixed(6);
  } catch (err) {
    console.error('[wallet/tronGasfree] getAgentTrxBalance failed:', err);
    return '0.000000';
  }
}
