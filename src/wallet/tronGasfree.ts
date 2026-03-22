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

// The agent's primary TRX address and private key (HD index 0) — used as the energy payer.
let agentTronAddress: string | null = null;
let agentPrivateKey: string | null = null;

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

  // Derive the agent's primary address and key (index 0)
  const account = TronWeb.fromMnemonic(seed, `m/44'/195'/0'/0/0`);
  agentTronAddress = account.address as string;
  agentPrivateKey = (account.privateKey as string).replace(/^0x/, '');

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
 * activateIfNeeded — Send a small TRX amount to activate an unactivated TRON address.
 *
 * An unactivated address (one that has never received TRX or been explicitly
 * created on-chain) cannot broadcast transactions — including the USDT transfer
 * needed to forward the payment. This function checks whether the address exists
 * on-chain and, if not, sends 1 TRX from the agent hot wallet to activate it.
 *
 * The 1 TRX stays at the address. For pool addresses that get reused, the
 * activation cost is paid only once.
 *
 * Returns true if the address was activated (or was already active), false on error.
 */
export async function activateIfNeeded(address: string): Promise<boolean> {
  if (!tronWeb || !agentTronAddress || !agentPrivateKey) {
    console.warn('[wallet/tronGasfree] activateIfNeeded: not initialised.');
    return false;
  }

  try {
    // getAccount returns an empty object for unactivated addresses.
    const accountInfo = await tronWeb.trx.getAccount(address);
    const isActivated = accountInfo && Object.keys(accountInfo).length > 0;

    if (isActivated) {
      return true;
    }

    console.log(`[wallet/tronGasfree] Address ${address} is unactivated — sending 1 TRX to activate.`);

    const signerWeb = new TronWeb({
      fullHost: tronGridUrl,
      headers: apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {},
      privateKey: agentPrivateKey,
    });

    // Check agent TRX balance before attempting — a zero balance is the most
    // common reason for a silent rejection and needs an actionable error.
    const agentBalanceSun: number = await signerWeb.trx.getBalance(agentTronAddress);
    if (agentBalanceSun < 2_000_000) {
      console.error(
        `[wallet/tronGasfree] Cannot activate ${address}: agent wallet has only` +
        ` ${(agentBalanceSun / 1e6).toFixed(3)} TRX (need ≥2 TRX).` +
        ` Fund ${agentTronAddress} with Shasta TRX: https://shasta.tronex.io/`,
      );
      return false;
    }

    // Send 1 TRX (1_000_000 SUN) — the minimum to create the account on-chain.
    const tx = await signerWeb.trx.sendTransaction(address, 1_000_000);
    if (tx.result) {
      console.log(`[wallet/tronGasfree] Activation TX sent for ${address}: ${tx.txid}`);
      // Poll until the account is confirmed active on-chain (up to 15s / 5 blocks).
      // A fixed 3.5s sleep is not reliable — TronSave does its own activation
      // check and will reject with RECEIVER_ADDRESS_NOT_ACTIVE if we call too early.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const check = await tronWeb.trx.getAccount(address);
        if (check && Object.keys(check).length > 0) {
          console.log(`[wallet/tronGasfree] Address ${address} confirmed active after ${(i + 1) * 3}s.`);
          return true;
        }
      }
      // Activation TX was broadcast but account not yet visible — proceed anyway.
      console.warn(`[wallet/tronGasfree] Activation TX sent but account not yet visible after 15s for ${address}. Proceeding.`);
      return true;
    }

    // tx.result === false — log everything useful from the response.
    const reason = (tx as { message?: string })?.message ?? JSON.stringify(tx);
    console.error(
      `[wallet/tronGasfree] Activation TX rejected for ${address}. Reason: ${reason}`,
    );
    return false;
  } catch (err: unknown) {
    // TronWeb errors are often plain strings or objects — extract the message.
    const msg = typeof err === 'string' ? err
      : (err as { message?: string })?.message
      ?? JSON.stringify(err);
    console.error(`[wallet/tronGasfree] activateIfNeeded(${address}) threw: ${msg}`);
    return false;
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

  // TronSave and TR.ENERGY are mainnet-only services — they check activation
  // on mainnet and will reject any Shasta testnet address. Fall back to burn
  // when running against Shasta.
  const isTestnet = tronGridUrl.includes('shasta') || tronGridUrl.includes('nile');
  if (isTestnet) {
    console.log('[wallet/tronGasfree] Testnet detected — skipping rental providers, using burn.');
    return sponsorViaBurn(address, estimatedEnergy);
  }

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
    // TronSave API v2: POST /v2/buy-resource
    // (old /v2/energy/buy endpoint was removed)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.TRONSAVE_API_KEY) headers['apikey'] = process.env.TRONSAVE_API_KEY;

    const res = await axios.post(
      'https://api.tronsave.io/v2/buy-resource',
      {
        resourceType: 'ENERGY',
        unitPrice: 'MEDIUM',
        resourceAmount: energy,
        receiver: address,
        durationSec: 3600,
        options: { allowPartialFill: true },
      },
      { headers, timeout: 15_000 },
    );

    // Success is HTTP 201; orderId is in data.data.orderId
    const orderId = res.data?.data?.orderId ?? res.data?.orderId ?? '';
    console.log(`[wallet/tronGasfree] TronSave sponsor order placed for ${energy} energy. orderId: ${orderId}`);
    // TronSave doesn't return TRX cost in the order response — return 0 as placeholder.
    return { success: true, trxCost: '0' };
  } catch (err: unknown) {
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      ?? (err as { message?: string })?.message
      ?? String(err);
    console.warn(`[wallet/tronGasfree] TronSave sponsor failed (${msg}), falling back to burn.`);
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
 * sponsorViaBurn — Fund the payment address with enough TRX to cover energy costs.
 *
 * Last resort used when rental APIs (TronSave / TR.ENERGY) are unavailable
 * (e.g. testnet, API downtime). Sends TRX directly to the payment address;
 * when forwardPayment() executes the USDT transfer, TRON burns that TRX for
 * energy at the current network rate.
 *
 * This is more expensive per-payment than energy rental (~27 TRX vs ~0.05 TRX
 * on mainnet) but guarantees the transfer goes through without external APIs.
 * On mainnet the rental providers should be preferred; this is only the fallback.
 */
async function sponsorViaBurn(
  address: string,
  energy: number,
): Promise<{ success: boolean; trxCost: string }> {
  if (!agentTronAddress || !agentPrivateKey) {
    console.error('[wallet/tronGasfree] sponsorViaBurn: not initialised.');
    return { success: false, trxCost: '0' };
  }

  try {
    const { getLatestEnergyData } = await import('../intelligence/energy');
    const energyData = getLatestEnergyData();
    // Burn rate: sun per energy unit. Default 420 sun (≈ mainnet typical).
    const priceSun = energyData?.energyPriceSun ?? 420;
    // Add 20% buffer so the transfer doesn't fail due to price fluctuation.
    const sunNeeded = Math.ceil(energy * priceSun * 1.2);
    const trxNeeded = sunNeeded / 1_000_000;

    const agentBalanceSun: number = await tronWeb.trx.getBalance(agentTronAddress);
    if (agentBalanceSun < sunNeeded + 2_000_000) {
      console.error(
        `[wallet/tronGasfree] sponsorViaBurn: agent has ${(agentBalanceSun / 1e6).toFixed(3)} TRX,` +
        ` need ${(trxNeeded + 2).toFixed(3)} TRX. Fund ${agentTronAddress}.`,
      );
      return { success: false, trxCost: '0' };
    }

    const signerWeb = new TronWeb({
      fullHost: tronGridUrl,
      headers: apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {},
      privateKey: agentPrivateKey,
    });

    const tx = await signerWeb.trx.sendTransaction(address, sunNeeded);
    if (!tx.result) {
      const reason = (tx as { message?: string })?.message ?? JSON.stringify(tx);
      console.error(`[wallet/tronGasfree] sponsorViaBurn TX rejected: ${reason}`);
      return { success: false, trxCost: '0' };
    }

    console.log(
      `[wallet/tronGasfree] Burn sponsor: sent ${trxNeeded.toFixed(6)} TRX to ${address}` +
      ` to cover ${energy} energy. TX: ${tx.txid}`,
    );
    return { success: true, trxCost: trxNeeded.toFixed(6) };
  } catch (err: unknown) {
    const msg = typeof err === 'string' ? err : (err as { message?: string })?.message ?? JSON.stringify(err);
    console.error(`[wallet/tronGasfree] sponsorViaBurn failed: ${msg}`);
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
