/**
 * src/wallet/aave.ts — Aave v3 lending module (Arbitrum)
 *
 * The agent deposits idle USDT float into Aave v3 on Arbitrum to earn yield
 * while it is not actively needed for payment forwarding.
 *
 * Capital allocation philosophy (from AGENTS.md):
 *   - Keep AAVE_MIN_FLOAT_DAYS × avg_daily_volume as liquid USDT.
 *   - Deposit the rest into Aave.
 *   - Withdraw as needed when the liquid float drops below the minimum.
 *
 * This module is a thin execution layer. The decision logic lives in
 * AGENTS.md (LLM instructions) and src/agent/tools/capital.ts (tool wrapper).
 *
 * Implementation: uses ethers v6 to call the Aave v3 Pool contract directly.
 * When @tetherto/wdk-protocol-lending-aave-evm is published, the internals
 * can be swapped without changing callers.
 */

import { ethers } from 'ethers';

// Aave v3 pool and asset addresses — configurable via env vars so the same
// code works on both mainnet (Arbitrum One) and testnet (Arbitrum Sepolia).
//
// Mainnet (Arbitrum One):
//   AAVE_POOL_ADDRESS      = 0x794a61358D6845594F94dc1DB02A252b5b4814aD
//   AAVE_USDT_ASSET_ADDRESS = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9  (USDT, 6 dec)
//   AAVE_USDC_ASSET_ADDRESS = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831  (USDC, 6 dec)
//
// Testnet (Arbitrum Sepolia):
//   AAVE_POOL_ADDRESS      = 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff
//   AAVE_USDT_ASSET_ADDRESS = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d  (USDC stand-in, 6 dec)
//   ARBITRUM_RPC_URL       = https://sepolia-rollup.arbitrum.io/rpc
const AAVE_POOL_ADDRESS =
  process.env.AAVE_POOL_ADDRESS ?? '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
// AAVE_ASSET_ADDRESS kept for backwards-compat with existing .env files (maps to USDT)
const AAVE_USDT_ASSET_ADDRESS =
  process.env.AAVE_ASSET_ADDRESS ?? '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const AAVE_USDC_ASSET_ADDRESS =
  process.env.AAVE_USDC_ASSET_ADDRESS ?? '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

export type AaveAsset = 'usdt' | 'usdc';

function assetAddress(asset: AaveAsset): string {
  return asset === 'usdc' ? AAVE_USDC_ASSET_ADDRESS : AAVE_USDT_ASSET_ADDRESS;
}

// Aave v3 Pool ABI — only the functions we need.
const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)',
];

// aToken ABI for balance query
const ATOKEN_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// ERC-20 ABI for approve
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// RAY (27 decimal) constant for APY calculation
const RAY = 10n ** 27n;

let arbitrumProvider: ethers.JsonRpcProvider | null = null;
let agentSigner: ethers.Wallet | null = null;
// aToken addresses cached per asset (populated on first getDepositedBalance call per asset)
const aTokenAddressCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * initAave — Boot the Aave module using the EVM wallet's Arbitrum signer.
 *
 * Called after initEvmWallet() in src/index.ts.
 */
export async function initAave(): Promise<void> {
  const seed = process.env.WDK_SEED_PHRASE;
  if (!seed) throw new Error('[wallet/aave] WDK_SEED_PHRASE is not set.');

  const arbitrumRpc = process.env.ARBITRUM_RPC_URL;
  if (!arbitrumRpc) {
    console.warn('[wallet/aave] ARBITRUM_RPC_URL not set — Aave features disabled.');
    return;
  }

  arbitrumProvider = new ethers.JsonRpcProvider(arbitrumRpc);

  const hdWallet = ethers.HDNodeWallet.fromPhrase(seed, undefined, "m/44'/60'/0'/0/0");
  agentSigner = new ethers.Wallet(hdWallet.privateKey, arbitrumProvider);

  console.log('[wallet/aave] Aave module initialised. Signer:', agentSigner.address);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getATokenAddress(asset: AaveAsset): Promise<string> {
  const addr = assetAddress(asset);
  const cached = aTokenAddressCache.get(addr);
  if (cached) return cached;
  if (!arbitrumProvider) throw new Error('[wallet/aave] Not initialised.');

  const pool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, arbitrumProvider);
  const reserveData = await pool.getReserveData(addr);
  // aTokenAddress is at index 8 in the return tuple
  const aToken = reserveData[8] as string;
  aTokenAddressCache.set(addr, aToken);
  return aToken;
}

// ---------------------------------------------------------------------------
// Deposits and withdrawals
// ---------------------------------------------------------------------------

/**
 * deposit — Deposit USDT or USDC into the Aave lending pool.
 *
 * Both assets have 6 decimals on Arbitrum.
 * Returns the supply transaction hash.
 */
export async function deposit(amount: string, asset: AaveAsset = 'usdt'): Promise<string> {
  if (!agentSigner) throw new Error('[wallet/aave] Not initialised.');

  const contractAddr = assetAddress(asset);
  const amountWei = ethers.parseUnits(amount, 6);
  const agentAddress = agentSigner.address;

  const token = new ethers.Contract(contractAddr, ERC20_ABI, agentSigner);
  const pool  = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, agentSigner);

  const allowance = await token.allowance(agentAddress, AAVE_POOL_ADDRESS) as bigint;
  if (allowance < amountWei) {
    const approveTx = await token.approve(AAVE_POOL_ADDRESS, ethers.MaxUint256);
    await approveTx.wait();
    console.log(`[wallet/aave] Approved ${asset.toUpperCase()} spend.`);
  }

  const tx = await pool.supply(contractAddr, amountWei, agentAddress, 0);
  const receipt = await tx.wait();

  console.log(`[wallet/aave] Deposited ${amount} ${asset.toUpperCase()}. TX: ${receipt.hash}`);
  return receipt.hash as string;
}

/**
 * withdraw — Withdraw USDT or USDC from the Aave lending pool.
 *
 * Pass 'MAX' to withdraw the entire position for the given asset.
 */
export async function withdraw(amount: string, asset: AaveAsset = 'usdt'): Promise<string> {
  if (!agentSigner) throw new Error('[wallet/aave] Not initialised.');

  const contractAddr = assetAddress(asset);
  const agentAddress = agentSigner.address;
  const pool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, agentSigner);

  const amountWei = amount === 'MAX' ? ethers.MaxUint256 : ethers.parseUnits(amount, 6);

  const tx = await pool.withdraw(contractAddr, amountWei, agentAddress);
  const receipt = await tx.wait();

  console.log(`[wallet/aave] Withdrew ${amount} ${asset.toUpperCase()}. TX: ${receipt.hash}`);
  return receipt.hash as string;
}

// ---------------------------------------------------------------------------
// Balance and APY queries
// ---------------------------------------------------------------------------

/**
 * getDepositedBalance — Return the current aToken position as a decimal string.
 *
 * The aToken balance equals the asset claimable (principal + accrued yield),
 * and grows in real-time as yield accrues.
 */
export async function getDepositedBalance(asset: AaveAsset = 'usdt'): Promise<string> {
  if (!agentSigner || !arbitrumProvider) throw new Error('[wallet/aave] Not initialised.');

  try {
    const aToken = await getATokenAddress(asset);
    const contract = new ethers.Contract(aToken, ATOKEN_ABI, arbitrumProvider);
    const [raw, decimals] = await Promise.all([
      contract.balanceOf(agentSigner.address) as Promise<bigint>,
      contract.decimals() as Promise<bigint>,
    ]);
    const factor = 10n ** decimals;
    const whole = raw / factor;
    const frac = raw % factor;
    return `${whole}.${frac.toString().padStart(Number(decimals), '0')}`;
  } catch (err) {
    console.error(`[wallet/aave] getDepositedBalance(${asset}) failed:`, err);
    return '0.000000';
  }
}

/**
 * getCurrentApy — Fetch the live Aave supply APY for the given asset on Arbitrum.
 *
 * Returns as a percentage string, e.g. "4.23" (meaning 4.23% APY).
 */
export async function getCurrentApy(asset: AaveAsset = 'usdt'): Promise<string> {
  if (!arbitrumProvider) throw new Error('[wallet/aave] Not initialised.');

  try {
    const pool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, arbitrumProvider);
    const reserveData = await pool.getReserveData(assetAddress(asset));
    // currentLiquidityRate is at index 2, in ray (27 decimals)
    const liquidityRateRay: bigint = BigInt(reserveData[2]);

    // currentLiquidityRate is already the annualised APR in RAY (1e27) units.
    // At typical DeFi rates (< 20%) APR ≈ APY to within ~1%, so we show APR.
    const apyBps = (liquidityRateRay * 10000n) / RAY; // basis points (1 bp = 0.01%)
    const apyPercent = Number(apyBps) / 100;

    return apyPercent.toFixed(2);
  } catch (err) {
    console.error(`[wallet/aave] getCurrentApy(${asset}) failed:`, err);
    return '4.50'; // reasonable fallback
  }
}
