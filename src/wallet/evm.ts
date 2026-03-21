/**
 * src/wallet/evm.ts — EVM wallet module (Base + Arbitrum)
 *
 * The agent operates on two EVM chains:
 *   - Base: receives USDC from x402 API fee payments (micro-transactions).
 *   - Arbitrum: holds USDT for Aave lending yield.
 *
 * Both chains derive from the same seed phrase as the TRON wallet,
 * using standard EVM BIP-44 derivation (coin type 60), HD index 0.
 *
 * USDC from x402 (Base) is periodically consolidated to USDT on Arbitrum
 * via the Velora swap protocol. That consolidation is triggered by the
 * USDC consolidation cron job (monitoring/scheduler.ts).
 *
 * Implementation: uses ethers v6 (added to package.json) for HD derivation
 * and ERC-20 balance queries. When @tetherto/wdk-wallet-evm and
 * @tetherto/wdk-protocol-swap-velora-evm become available, the internals
 * here can be replaced without changing callers.
 */

import { ethers } from 'ethers';

export type EvmChain = 'base' | 'arbitrum';

// ERC-20 ABI subset — only the functions we need.
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// Uniswap v3 SwapRouter02 ABI — exactInputSingle only.
const SWAP_ROUTER_ABI = [
  `function exactInputSingle(
    (address tokenIn, address tokenOut, uint24 fee, address recipient,
     uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)
  ) payable returns (uint256 amountOut)`,
];

// WETH9 ABI — deposit/withdraw for ETH↔WETH wrapping.
const WETH9_ABI = [
  'function deposit() payable',
  'function withdraw(uint256 wad)',
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// Token addresses — override via env vars to switch between mainnet and testnet.
// Mainnet defaults are set here; see .env.testnet for Arbitrum Sepolia / Base Sepolia values.
const USDC_BASE      = process.env.USDC_BASE_ADDRESS      ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_ARBITRUM  = process.env.USDC_ARBITRUM_ADDRESS  ?? '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const USDT_ARBITRUM  = process.env.USDT_ARBITRUM_ADDRESS  ?? '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';

// Uniswap v3 on Arbitrum
const UNISWAP_SWAP_ROUTER = process.env.UNISWAP_SWAP_ROUTER        ?? '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const WETH9_ARBITRUM      = process.env.WETH9_ARBITRUM_ADDRESS      ?? '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const USDT_WETH_POOL_FEE  = 500; // 0.05% fee tier (most liquid USDT/WETH pool on Arbitrum)

// Uniswap v3 on Base
const UNISWAP_SWAP_ROUTER_BASE = process.env.UNISWAP_SWAP_ROUTER_BASE ?? '0x2626664c2603336E57B271c5C0b26F421741e481';
const WETH9_BASE               = process.env.WETH9_BASE_ADDRESS        ?? '0x4200000000000000000000000000000000000006';
const USDC_WETH_POOL_FEE_BASE  = 500; // 0.05% fee tier (most liquid USDC/WETH pool on Base)

// EVM BIP-44 derivation path (coin type 60, index 0 for the agent wallet)
const EVM_HD_PATH = "m/44'/60'/0'/0/0";

// Providers and signer (initialised at startup)
let baseProvider: ethers.JsonRpcProvider | null = null;
let arbitrumProvider: ethers.JsonRpcProvider | null = null;
let baseSigner: ethers.Wallet | null = null;
let arbitrumSigner: ethers.Wallet | null = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * initEvmWallet — Boot the EVM wallet from the environment seed.
 *
 * Must be called once at startup (src/index.ts).
 */
export async function initEvmWallet(): Promise<void> {
  const seed = process.env.WDK_SEED_PHRASE;
  if (!seed) throw new Error('[wallet/evm] WDK_SEED_PHRASE is not set.');

  const baseRpc = process.env.BASE_RPC_URL;
  const arbitrumRpc = process.env.ARBITRUM_RPC_URL;
  if (!baseRpc) throw new Error('[wallet/evm] BASE_RPC_URL is not set.');
  if (!arbitrumRpc) throw new Error('[wallet/evm] ARBITRUM_RPC_URL is not set.');

  // Derive the EVM private key from the mnemonic.
  const hdWallet = ethers.HDNodeWallet.fromPhrase(seed, undefined, EVM_HD_PATH);

  baseProvider = new ethers.JsonRpcProvider(baseRpc);
  arbitrumProvider = new ethers.JsonRpcProvider(arbitrumRpc);

  baseSigner = new ethers.Wallet(hdWallet.privateKey, baseProvider);
  arbitrumSigner = new ethers.Wallet(hdWallet.privateKey, arbitrumProvider);

  console.log('[wallet/evm] EVM wallet initialised. Address:', hdWallet.address);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProvider(chain: EvmChain): ethers.JsonRpcProvider {
  const provider = chain === 'base' ? baseProvider : arbitrumProvider;
  if (!provider) throw new Error('[wallet/evm] Wallet not initialised.');
  return provider;
}

/** Return the current base gas price in gwei for the given chain. */
export async function getGasPriceGwei(chain: EvmChain): Promise<number> {
  const feeData = await getProvider(chain).getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (!gasPrice) return 0;
  return Number(gasPrice) / 1e9;
}

/**
 * getSigner — Return the ethers.Wallet signer for the given chain.
 *
 * Used by bridge.ts to broadcast EVM source-chain transactions without
 * creating a circular import (bridge imports evm, not the other way around).
 */
export function getSigner(chain: EvmChain): ethers.Wallet {
  const signer = chain === 'base' ? baseSigner : arbitrumSigner;
  if (!signer) throw new Error('[wallet/evm] Wallet not initialised.');
  return signer;
}

async function getErc20Balance(
  contractAddress: string,
  walletAddress: string,
  provider: ethers.JsonRpcProvider,
): Promise<string> {
  const contract = new ethers.Contract(contractAddress, ERC20_ABI, provider);
  const [raw, decimals] = await Promise.all([
    contract.balanceOf(walletAddress) as Promise<bigint>,
    contract.decimals() as Promise<bigint>,
  ]);
  const factor = 10n ** decimals;
  const whole = raw / factor;
  const frac = raw % factor;
  return `${whole}.${frac.toString().padStart(Number(decimals), '0')}`;
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/**
 * getUsdcBalance — Return the USDC balance on Base as a decimal string.
 *
 * Used for tracking x402 income and deciding when to consolidate.
 * USDC on Base has 6 decimal places.
 */
export async function getUsdcBalance(chain: EvmChain = 'base'): Promise<string> {
  if (!baseSigner) throw new Error('[wallet/evm] Wallet not initialised.');

  try {
    const provider = getProvider(chain);
    const contractAddress = chain === 'base' ? USDC_BASE : USDC_ARBITRUM;
    return getErc20Balance(contractAddress, baseSigner.address, provider);
  } catch (err) {
    console.error(`[wallet/evm] getUsdcBalance(${chain}) failed:`, err);
    return '0.000000';
  }
}

/**
 * getUsdtBalance — Return the USDT balance on Arbitrum as a decimal string.
 */
export async function getUsdtBalance(chain: EvmChain = 'arbitrum'): Promise<string> {
  if (!arbitrumSigner) throw new Error('[wallet/evm] Wallet not initialised.');

  try {
    const provider = getProvider(chain);
    return getErc20Balance(USDT_ARBITRUM, arbitrumSigner.address, provider);
  } catch (err) {
    console.error(`[wallet/evm] getUsdtBalance(${chain}) failed:`, err);
    return '0.000000';
  }
}

/**
 * getWalletAddress — Return the agent's EVM address (same on all chains).
 */
export async function getWalletAddress(_chain: EvmChain): Promise<string> {
  if (!baseSigner) throw new Error('[wallet/evm] Wallet not initialised.');
  return baseSigner.address;
}

/**
 * getEthBalance — Return the native ETH balance on the given chain as a decimal string.
 *
 * Used to monitor the Arbitrum gas buffer. The agent needs ETH on Arbitrum for
 * Aave deposit/withdraw gas. When the balance dips below a threshold the anomaly
 * check fires and the agent can call swapUsdtForEth() to top up.
 */
export async function getEthBalance(chain: EvmChain): Promise<string> {
  const provider = getProvider(chain);
  const signer = chain === 'base' ? baseSigner : arbitrumSigner;
  if (!signer) throw new Error('[wallet/evm] Wallet not initialised.');

  const raw = await provider.getBalance(signer.address);
  return ethers.formatEther(raw);
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

/**
 * swapUsdtForEth — Swap USDT on Arbitrum for native ETH via Uniswap v3.
 *
 * Used by the agent to maintain the ETH gas buffer required for Aave operations.
 * Route: USDT → WETH (via Uniswap v3 exactInputSingle, 0.05% fee tier) → ETH (via WETH9 withdraw).
 *
 * @param amountUsdt  Amount of USDT to swap, as a decimal string (e.g. "5.000000")
 * @returns           Transaction hash of the ETH unwrap (last step)
 */
export async function swapUsdtForEth(amountUsdt: string): Promise<string> {
  if (!arbitrumSigner) throw new Error('[wallet/evm] Wallet not initialised.');

  const usdtDecimals = 6n;
  const amountIn = BigInt(Math.round(parseFloat(amountUsdt) * 1_000_000));

  // Step 1: approve SwapRouter02 to spend USDT.
  const usdt = new ethers.Contract(USDT_ARBITRUM, ERC20_ABI, arbitrumSigner);
  const approveTx = await (usdt.approve as (spender: string, amount: bigint) => Promise<ethers.TransactionResponse>)(
    UNISWAP_SWAP_ROUTER,
    amountIn,
  );
  await approveTx.wait();

  // Step 2: swap USDT → WETH via Uniswap v3 exactInputSingle.
  // Recipient is the agent's own address so we can then unwrap.
  const router = new ethers.Contract(UNISWAP_SWAP_ROUTER, SWAP_ROUTER_ABI, arbitrumSigner);
  const params = {
    tokenIn: USDT_ARBITRUM,
    tokenOut: WETH9_ARBITRUM,
    fee: USDT_WETH_POOL_FEE,
    recipient: arbitrumSigner.address,
    amountIn,
    amountOutMinimum: 0n, // no price protection for now; add QuoterV2 in production
    sqrtPriceLimitX96: 0n,
  };

  void usdtDecimals; // referenced via amountIn — kept for documentation clarity

  const swapTx = await (router.exactInputSingle as (p: typeof params) => Promise<ethers.TransactionResponse>)(params);
  const swapReceipt = await swapTx.wait();
  if (!swapReceipt?.status) throw new Error('[wallet/evm] Uniswap swap failed');

  // Step 3: unwrap WETH → native ETH.
  const weth9 = new ethers.Contract(WETH9_ARBITRUM, WETH9_ABI, arbitrumSigner);
  const wethBalance: bigint = await (weth9.balanceOf as (addr: string) => Promise<bigint>)(arbitrumSigner.address);
  if (wethBalance === 0n) throw new Error('[wallet/evm] No WETH to unwrap after swap');

  const withdrawTx = await (weth9.withdraw as (wad: bigint) => Promise<ethers.TransactionResponse>)(wethBalance);
  const withdrawReceipt = await withdrawTx.wait();
  if (!withdrawReceipt?.status) throw new Error('[wallet/evm] WETH unwrap failed');

  const ethReceived = ethers.formatEther(wethBalance);
  console.log(`[wallet/evm] Swapped ${amountUsdt} USDT → ${ethReceived} ETH on Arbitrum. TX: ${withdrawReceipt.hash}`);
  return withdrawReceipt.hash;
}

/**
 * swapEthForUsdt — Swap native ETH on Arbitrum for USDT via Uniswap v3.
 *
 * Reverse of swapUsdtForEth. Used when the agent wants to redeploy idle ETH
 * into productive USDT for Aave.
 * Steps: wrap ETH → WETH → approve router → swap WETH→USDT.
 *
 * @param amountEth  Amount of ETH to swap, as a decimal string (e.g. "0.005")
 * @returns          Transaction hash of the swap
 */
export async function swapEthForUsdt(amountEth: string): Promise<string> {
  if (!arbitrumSigner) throw new Error('[wallet/evm] Wallet not initialised.');

  const amountWei = ethers.parseEther(amountEth);

  // Step 1: wrap ETH → WETH.
  const weth9 = new ethers.Contract(WETH9_ARBITRUM, WETH9_ABI, arbitrumSigner);
  const depositTx = await (weth9.deposit as (overrides: { value: bigint }) => Promise<ethers.TransactionResponse>)({ value: amountWei });
  await depositTx.wait();

  // Step 2: approve router to spend WETH.
  const approveTx = await (weth9.approve as (spender: string, amount: bigint) => Promise<ethers.TransactionResponse>)(
    UNISWAP_SWAP_ROUTER, amountWei,
  );
  await approveTx.wait();

  // Step 3: swap WETH → USDT via Uniswap v3 exactInputSingle.
  const router = new ethers.Contract(UNISWAP_SWAP_ROUTER, SWAP_ROUTER_ABI, arbitrumSigner);
  const swapTx = await (router.exactInputSingle as (p: object) => Promise<ethers.TransactionResponse>)({
    tokenIn: WETH9_ARBITRUM,
    tokenOut: USDT_ARBITRUM,
    fee: USDT_WETH_POOL_FEE,
    recipient: arbitrumSigner.address,
    amountIn: amountWei,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  });
  const receipt = await swapTx.wait();
  if (!receipt?.status) throw new Error('[wallet/evm] Uniswap ETH→USDT swap failed');

  console.log(`[wallet/evm] Swapped ${amountEth} ETH → USDT on Arbitrum. TX: ${receipt.hash}`);
  return receipt.hash;
}

/**
 * swapUsdcForEth — Swap USDC on Base for native ETH via Uniswap v3.
 *
 * Used when the agent needs ETH on Base for gas (e.g. deBridge protocol fees).
 * Steps: approve router → swap USDC→WETH → unwrap WETH→ETH.
 *
 * @param amountUsdc  Amount of USDC to swap, as a decimal string (e.g. "2.00")
 * @returns           Transaction hash of the unwrap
 */
export async function swapUsdcForEth(amountUsdc: string): Promise<string> {
  if (!baseSigner) throw new Error('[wallet/evm] Wallet not initialised.');

  const amountIn = BigInt(Math.round(parseFloat(amountUsdc) * 1_000_000));

  // Step 1: approve Base SwapRouter02 to spend USDC.
  const usdc = new ethers.Contract(USDC_BASE, ERC20_ABI, baseSigner);
  const approveTx = await (usdc.approve as (spender: string, amount: bigint) => Promise<ethers.TransactionResponse>)(
    UNISWAP_SWAP_ROUTER_BASE, amountIn,
  );
  await approveTx.wait();

  // Step 2: swap USDC → WETH via Uniswap v3 exactInputSingle.
  const router = new ethers.Contract(UNISWAP_SWAP_ROUTER_BASE, SWAP_ROUTER_ABI, baseSigner);
  const swapTx = await (router.exactInputSingle as (p: object) => Promise<ethers.TransactionResponse>)({
    tokenIn: USDC_BASE,
    tokenOut: WETH9_BASE,
    fee: USDC_WETH_POOL_FEE_BASE,
    recipient: baseSigner.address,
    amountIn,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  });
  const swapReceipt = await swapTx.wait();
  if (!swapReceipt?.status) throw new Error('[wallet/evm] Uniswap USDC→WETH swap failed');

  // Step 3: unwrap WETH → ETH.
  const weth9 = new ethers.Contract(WETH9_BASE, WETH9_ABI, baseSigner);
  const wethBalance: bigint = await (weth9.balanceOf as (addr: string) => Promise<bigint>)(baseSigner.address);
  const withdrawTx = await (weth9.withdraw as (wad: bigint) => Promise<ethers.TransactionResponse>)(wethBalance);
  const withdrawReceipt = await withdrawTx.wait();
  if (!withdrawReceipt?.status) throw new Error('[wallet/evm] WETH unwrap failed');

  console.log(`[wallet/evm] Swapped ${amountUsdc} USDC → ETH on Base. TX: ${withdrawReceipt.hash}`);
  return withdrawReceipt.hash;
}

/**
 * swapEthForUsdc — Swap native ETH on Base for USDC via Uniswap v3.
 *
 * Used when the agent wants to convert idle Base ETH into USDC for inference
 * payments or bridging.
 * Steps: wrap ETH → WETH → approve router → swap WETH→USDC.
 *
 * @param amountEth  Amount of ETH to swap, as a decimal string (e.g. "0.001")
 * @returns          Transaction hash of the swap
 */
export async function swapEthForUsdc(amountEth: string): Promise<string> {
  if (!baseSigner) throw new Error('[wallet/evm] Wallet not initialised.');

  const amountWei = ethers.parseEther(amountEth);

  // Step 1: wrap ETH → WETH.
  const weth9 = new ethers.Contract(WETH9_BASE, WETH9_ABI, baseSigner);
  const depositTx = await (weth9.deposit as (overrides: { value: bigint }) => Promise<ethers.TransactionResponse>)({ value: amountWei });
  await depositTx.wait();

  // Step 2: approve router to spend WETH.
  const approveTx = await (weth9.approve as (spender: string, amount: bigint) => Promise<ethers.TransactionResponse>)(
    UNISWAP_SWAP_ROUTER_BASE, amountWei,
  );
  await approveTx.wait();

  // Step 3: swap WETH → USDC.
  const router = new ethers.Contract(UNISWAP_SWAP_ROUTER_BASE, SWAP_ROUTER_ABI, baseSigner);
  const swapTx = await (router.exactInputSingle as (p: object) => Promise<ethers.TransactionResponse>)({
    tokenIn: WETH9_BASE,
    tokenOut: USDC_BASE,
    fee: USDC_WETH_POOL_FEE_BASE,
    recipient: baseSigner.address,
    amountIn: amountWei,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  });
  const receipt = await swapTx.wait();
  if (!receipt?.status) throw new Error('[wallet/evm] Uniswap ETH→USDC swap failed');

  console.log(`[wallet/evm] Swapped ${amountEth} ETH → USDC on Base. TX: ${receipt.hash}`);
  return receipt.hash;
}

/**
 * swapUsdcToUsdt — Swap USDC on Base to USDT on Arbitrum via Velora.
 *
 * NOTE: @tetherto/wdk-protocol-swap-velora-evm is not yet available as a
 * published package. This implementation is a placeholder that logs the
 * intent. When Velora is available, replace the body with the real swap call.
 *
 * Returns the amount of USDT received as a decimal string.
 */
/**
 * swapUsdcToUsdt — Bridge USDC on Base to USDT on Arbitrum via deBridge DLN.
 *
 * Called by the USDC consolidation cron (scheduler.ts). x402 fees accrue as
 * USDC on Base; this moves them to Arbitrum where they sit as idle capital
 * until the board meeting deposits them into Aave.
 *
 * Returns the deBridge order ID. Settlement is async (typically 30s–5min).
 * The scheduler logs the order ID; the board meeting agent can check its
 * status via get_bridge_order_status if needed.
 */
export async function swapUsdcToUsdt(amount: string): Promise<string> {
  if (!baseSigner || !arbitrumSigner) throw new Error('[wallet/evm] Wallet not initialised.');
  const { bridgeBaseToArbitrum } = await import('./bridge');
  return bridgeBaseToArbitrum(amount);
}
