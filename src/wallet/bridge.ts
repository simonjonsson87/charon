/**
 * src/wallet/bridge.ts — Cross-chain bridging
 *
 * Two bridge providers are used depending on the route:
 *
 * deBridge DLN — used for Tron→Arbitrum, Base→Arbitrum, Arb USDC→Base, Arb ETH→Base.
 *   Intent/solver bridge; adds Tron support in Aug 2025. ~$0.01–0.05 per order.
 *   Chain IDs: Tron=100000026 (internal), Arbitrum=42161, Base=8453.
 *   Flow: create-tx → sign → broadcast → poll status.
 *
 * Symbiosis Finance — used for Arbitrum USDT → Tron USDT.
 *   Percentage-based bridge (~0.4%), public hosted REST API, no API key.
 *   Dramatically cheaper than deBridge for amounts <$2000 (deBridge charges ~$8 flat).
 *   Chain IDs: standard EVM IDs — Tron=728126428, Arbitrum=42161.
 *   Tron addresses must be in hex format (0x...) not base58.
 *   Flow: POST /v1/swap → sign EVM tx on Arbitrum → poll GET /v1/tx/42161/{txHash}.
 */

import axios from 'axios';

const DEBRIDGE_API  = 'https://dln.debridge.finance/v1.0';
const SYMBIOSIS_API = 'https://api.symbiosis.finance/crosschain';

// deBridge chain identifiers — deBridge has no testnet; these are always mainnet values.
const CHAIN_TRON     = 100000026; // deBridge internal ID — NOT the standard EVM chain ID (728126428)
const CHAIN_ARBITRUM = 42161;
const CHAIN_BASE     = 8453;

// Symbiosis uses standard chain IDs.
const CHAIN_TRON_SYMBIOSIS = 728126428;

// Token addresses used in bridge orders — match the env vars in evm.ts / tron.ts.
const USDT_TRON      = process.env.TRON_USDT_CONTRACT     ?? 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
// Tron USDT in EVM hex format — Symbiosis requires hex, not base58.
const USDT_TRON_HEX  = '0xa614f803B6Fd780986A42c78EC9c7f77e6DED13c';
const USDT_ARBITRUM  = process.env.USDT_ARBITRUM_ADDRESS  ?? '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const USDC_ARBITRUM  = process.env.USDC_ARBITRUM_ADDRESS  ?? '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const USDC_BASE      = process.env.USDC_BASE_ADDRESS      ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// deBridge uses the zero address to represent native ETH on EVM chains.
const NATIVE_ETH     = '0x0000000000000000000000000000000000000000';

export type BridgeOrderStatus =
  | 'created'
  | 'fulfilled'
  | 'sentUnlock'
  | 'orderCancelled'
  | 'unknown';

export interface BridgeOrder {
  orderId: string;
  status: BridgeOrderStatus;
  /** Estimated destination amount (may be null until fulfilled). */
  dstAmount?: string;
  /** deBridge explorer URL for manual inspection. */
  explorerUrl: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * getAgentEvmAddress — returns the agent's EVM address (same on Base and Arbitrum).
 * Imported lazily to avoid circular deps at module init time.
 */
async function getAgentEvmAddress(): Promise<string> {
  const { getWalletAddress } = await import('./evm');
  return getWalletAddress('arbitrum');
}

/**
 * getAgentTronAddress — returns the agent's primary Tron address (index 0).
 */
async function getAgentTronAddress(): Promise<string> {
  const { getTronWalletAddress } = await import('./tron');
  return getTronWalletAddress(0);
}

// ---------------------------------------------------------------------------
// Bridge: Tron USDT → Arbitrum USDT
// ---------------------------------------------------------------------------

/**
 * bridgeTronToArbitrum — Bridge USDT from Tron to Arbitrum USDT via deBridge DLN.
 *
 * Called by the agent when it needs to move relay fee revenue from Tron to
 * Arbitrum for Aave yield deployment. Typically triggered when the liquid Tron
 * balance exceeds the minimum float by a meaningful margin.
 *
 * @param amountUsdt  Amount of Tron USDT to bridge (decimal string, e.g. "100.00")
 * @returns           deBridge order ID for status tracking
 */
export async function bridgeTronToArbitrum(amountUsdt: string): Promise<string> {
  const [tronSender, arbReceiver] = await Promise.all([
    getAgentTronAddress(),
    getAgentEvmAddress(),
  ]);

  return createAndSubmitOrder({
    srcChainId: CHAIN_TRON,
    srcChainTokenIn: USDT_TRON,
    srcChainTokenInAmount: amountUsdt,
    dstChainId: CHAIN_ARBITRUM,
    dstChainTokenOut: USDT_ARBITRUM,
    dstChainTokenOutRecipient: arbReceiver,
    srcChainOrderAuthorityAddress: tronSender,
    dstChainOrderAuthorityAddress: arbReceiver,
    description: `${amountUsdt} USDT Tron→Arbitrum`,
  });
}

// ---------------------------------------------------------------------------
// Bridge: Base USDC → Arbitrum USDT (x402 fee consolidation)
// ---------------------------------------------------------------------------

/**
 * bridgeBaseToArbitrum — Bridge USDC from Base to USDT on Arbitrum via deBridge DLN.
 *
 * Called daily by the consolidation cron. x402 inference fees land as USDC on Base;
 * this moves them to Arbitrum where they sit as idle USDT until the next board meeting
 * deposits them into Aave.
 *
 * Note: deBridge charges a small protocol fee in native ETH on the source chain
 * (~$0.01–0.05 per order). The Base wallet needs a small ETH balance for this.
 *
 * @param amountUsdc  Amount of USDC to bridge (decimal string, e.g. "15.00")
 * @returns           deBridge order ID for status tracking
 */
export async function bridgeBaseToArbitrum(amountUsdc: string): Promise<string> {
  const evmAddress = await getAgentEvmAddress();

  return createAndSubmitOrder({
    srcChainId: CHAIN_BASE,
    srcChainTokenIn: USDC_BASE,
    srcChainTokenInAmount: amountUsdc,
    dstChainId: CHAIN_ARBITRUM,
    dstChainTokenOut: USDT_ARBITRUM,
    dstChainTokenOutRecipient: evmAddress,
    srcChainOrderAuthorityAddress: evmAddress,
    dstChainOrderAuthorityAddress: evmAddress,
    description: `${amountUsdc} USDC Base→Arbitrum USDT`,
  });
}

// ---------------------------------------------------------------------------
// Bridge: Tron USDT → Base USDC (developer payout)
// ---------------------------------------------------------------------------

/**
 * bridgeTronToBase — Bridge USDT from Tron to Base USDC for a developer payout.
 *
 * Used when a developer has registered with `payout_chain: 'base'`. The relay
 * receives USDT on Tron from the buyer, then bridges net amount to the developer's
 * Base address as USDC.
 *
 * @param amountUsdt       Net amount to bridge (decimal string)
 * @param recipientBase    Developer's Base address (0x...)
 * @returns                deBridge order ID
 */
export async function bridgeTronToBase(
  amountUsdt: string,
  recipientBase: string,
): Promise<string> {
  const [tronSender, arbAddress] = await Promise.all([
    getAgentTronAddress(),
    getAgentEvmAddress(),
  ]);

  return createAndSubmitOrder({
    srcChainId: CHAIN_TRON,
    srcChainTokenIn: USDT_TRON,
    srcChainTokenInAmount: amountUsdt,
    dstChainId: CHAIN_BASE,
    dstChainTokenOut: USDC_BASE,
    dstChainTokenOutRecipient: recipientBase,
    srcChainOrderAuthorityAddress: tronSender,
    // Authority on dst side: use the agent's EVM address so it can cancel if needed.
    dstChainOrderAuthorityAddress: arbAddress,
    description: `${amountUsdt} USDT Tron→Base (developer payout)`,
  });
}

// ---------------------------------------------------------------------------
// Bridge: Arbitrum USDT → Tron USDT (capital repatriation via Symbiosis Finance)
// ---------------------------------------------------------------------------

/**
 * bridgeArbitrumToTron — Bridge USDT from Arbitrum to Tron via Symbiosis Finance.
 *
 * Symbiosis is used instead of deBridge for this route because deBridge charges
 * ~$8 flat fee regardless of amount, making small transfers uneconomical. Symbiosis
 * charges ~0.4% which is dramatically cheaper for amounts under ~$2000.
 *
 * Symbiosis uses the standard Tron chain ID (728126428) and requires the recipient
 * address in hex format — base58 Tron addresses are converted via tronBase58ToEvmHex().
 *
 * @param amountUsdt  Amount of Arbitrum USDT to bridge (decimal string, e.g. "50.00")
 * @returns           Arbitrum source tx hash (use getSymbiosisOrderStatus to track)
 */
export async function bridgeArbitrumToTron(amountUsdt: string): Promise<string> {
  const [evmAddress, tronAddress] = await Promise.all([
    getAgentEvmAddress(),
    getAgentTronAddress(),
  ]);

  const tronAddressHex = tronBase58ToEvmHex(tronAddress);
  const amountSmallest = BigInt(Math.round(parseFloat(amountUsdt) * 1_000_000)).toString();

  let res;
  try {
    res = await axios.post(`${SYMBIOSIS_API}/v1/swap`, {
      tokenAmountIn: {
        address: USDT_ARBITRUM,
        chainId: CHAIN_ARBITRUM,
        decimals: 6,
        amount: amountSmallest,
        symbol: 'USDT',
      },
      tokenOut: {
        address: USDT_TRON_HEX,
        chainId: CHAIN_TRON_SYMBIOSIS,
        decimals: 6,
        symbol: 'USDT',
      },
      from: evmAddress,
      to: tronAddressHex,
      slippage: 300,
    }, { timeout: 20_000 });
  } catch (err: unknown) {
    const axErr = err as { response?: { status?: number; data?: unknown } };
    const detail = axErr.response?.data ? JSON.stringify(axErr.response.data) : String(err);
    throw new Error(`[wallet/bridge] Symbiosis API error (HTTP ${axErr.response?.status ?? '?'}): ${detail}`);
  }

  const txData = res.data?.tx;
  if (!txData) {
    throw new Error(`[wallet/bridge] Symbiosis did not return tx data. Response: ${JSON.stringify(res.data)}`);
  }

  // Symbiosis routes through a MetaRouter — the contract that calls transferFrom
  // is NOT txData.to. Use the approveTo field returned by the API if present.
  const approveTo: string = res.data?.approveTo ?? txData.to;
  console.log(`[wallet/bridge] Symbiosis approveTo: ${approveTo} (tx.to: ${txData.to})`);

  const txHash = await broadcastEvmBridgeTx(txData, CHAIN_ARBITRUM, USDT_ARBITRUM, approveTo);
  console.log(`[wallet/bridge] ${amountUsdt} USDT Arbitrum→Tron (Symbiosis) — txHash: ${txHash}`);
  return txHash;
}

/**
 * getSymbiosisOrderStatus — Poll the status of a Symbiosis Arbitrum→Tron transfer.
 *
 * @param arbTxHash  The Arbitrum source tx hash returned by bridgeArbitrumToTron
 */
export async function getSymbiosisOrderStatus(
  arbTxHash: string,
): Promise<{ txHash: string; status: string; description: string }> {
  try {
    const res = await axios.get(
      `${SYMBIOSIS_API}/v1/tx/42161/${arbTxHash}`,
      { timeout: 10_000 },
    );
    const code = res.data?.status;
    // Symbiosis status codes: 0=Success, 1=Pending, 2=Stucked, 3=Reverted
    const descriptions: Record<number, string> = { 0: 'completed', 1: 'pending', 2: 'stucked', 3: 'reverted' };
    const description = descriptions[code as number] ?? 'unknown';
    return { txHash: arbTxHash, status: String(code), description };
  } catch (err) {
    console.warn(`[wallet/bridge] getSymbiosisOrderStatus(${arbTxHash}) failed:`, err);
    return { txHash: arbTxHash, status: 'unknown', description: 'status check failed' };
  }
}

// ---------------------------------------------------------------------------
// Bridge: Arbitrum USDC → Base USDC
// ---------------------------------------------------------------------------

/**
 * bridgeArbitrumUsdcToBase — Bridge USDC from Arbitrum to Base USDC via deBridge DLN.
 *
 * Used when the agent wants to consolidate USDC on Base (e.g. to fund x402
 * payment gas or move USDC to where it earns better yield).
 *
 * @param amountUsdc  Amount of Arbitrum USDC to bridge (decimal string, e.g. "10.00")
 * @returns           deBridge order ID for status tracking
 */
export async function bridgeArbitrumUsdcToBase(amountUsdc: string): Promise<string> {
  const evmAddress = await getAgentEvmAddress();

  return createAndSubmitOrder({
    srcChainId: CHAIN_ARBITRUM,
    srcChainTokenIn: USDC_ARBITRUM,
    srcChainTokenInAmount: amountUsdc,
    dstChainId: CHAIN_BASE,
    dstChainTokenOut: USDC_BASE,
    dstChainTokenOutRecipient: evmAddress,
    srcChainOrderAuthorityAddress: evmAddress,
    dstChainOrderAuthorityAddress: evmAddress,
    description: `${amountUsdc} USDC Arbitrum→Base`,
  });
}

// ---------------------------------------------------------------------------
// Bridge: Arbitrum ETH → Base ETH
// ---------------------------------------------------------------------------

/**
 * bridgeArbitrumEthToBase — Bridge native ETH from Arbitrum to Base via deBridge DLN.
 *
 * Used when the Base wallet needs ETH for gas (e.g. to cover deBridge protocol
 * fees on Base-source bridge orders). deBridge represents native ETH as the
 * zero address on both chains.
 *
 * @param amountEth  Amount of ETH to bridge (decimal string, e.g. "0.005")
 * @returns          deBridge order ID for status tracking
 */
export async function bridgeArbitrumEthToBase(amountEth: string): Promise<string> {
  const evmAddress = await getAgentEvmAddress();

  // deBridge expects the amount in wei for native ETH (18 decimals).
  // We override createAndSubmitOrder's 6-decimal conversion by pre-converting here
  // and passing '1' as the decimal amount to the shared helper won't work —
  // instead we call the API directly with the wei amount.
  const { ethers } = await import('ethers');
  const amountWei = ethers.parseEther(amountEth).toString();

  const axios = (await import('axios')).default;
  const res = await axios.get(`${DEBRIDGE_API}/dln/order/create-tx`, {
    params: {
      srcChainId: CHAIN_ARBITRUM,
      srcChainTokenIn: NATIVE_ETH,
      srcChainTokenInAmount: amountWei,
      dstChainId: CHAIN_BASE,
      dstChainTokenOut: NATIVE_ETH,
      dstChainTokenOutAmount: 'auto',
      dstChainTokenOutRecipient: evmAddress,
      srcChainOrderAuthorityAddress: evmAddress,
      dstChainOrderAuthorityAddress: evmAddress,
      prependOperatingExpenses: true,
    },
    timeout: 15_000,
  });

  const orderId: string = res.data?.orderId ?? res.data?.estimation?.orderId;
  if (!orderId) {
    throw new Error(`[wallet/bridge] deBridge did not return an orderId. Response: ${JSON.stringify(res.data)}`);
  }

  const txData = res.data?.tx;
  if (!txData) {
    throw new Error(`[wallet/bridge] deBridge did not return tx data. Response: ${JSON.stringify(res.data)}`);
  }

  await broadcastEvmBridgeTx(txData, CHAIN_ARBITRUM, NATIVE_ETH);

  console.log(`[wallet/bridge] ${amountEth} ETH Arbitrum→Base — orderId: ${orderId}`);
  return orderId;
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

/**
 * getBridgeOrderStatus — Poll the status of a deBridge DLN order.
 *
 * The agent should poll every 30–60 seconds until status is 'fulfilled'.
 * For developer payouts, fire the webhook after fulfillment.
 */
export async function getBridgeOrderStatus(orderId: string): Promise<BridgeOrder> {
  try {
    const res = await axios.get(
      `${DEBRIDGE_API}/dln/order/${encodeURIComponent(orderId)}/status`,
      { timeout: 10_000 },
    );

    const raw = res.data;
    const status = mapDlnStatus(raw?.status ?? raw?.orderStatus);

    return {
      orderId,
      status,
      dstAmount: raw?.dstChainTokenOut?.amount ?? undefined,
      explorerUrl: `https://app.debridge.finance/order?orderId=${orderId}`,
    };
  } catch (err) {
    console.warn(`[wallet/bridge] getBridgeOrderStatus(${orderId}) failed:`, err);
    return {
      orderId,
      status: 'unknown',
      explorerUrl: `https://app.debridge.finance/order?orderId=${orderId}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Fee quotes (read-only — no broadcast)
// ---------------------------------------------------------------------------

export interface BridgeQuote {
  route: string;           // human-readable, e.g. "Arbitrum USDT → Tron USDT"
  inputAmount: string;     // total deducted from wallet (transfer + fees), decimal
  outputAmount: string;    // amount received on destination, decimal
  feePaidByUser: string;   // inputAmount - outputAmount, decimal
  feePct: string;          // fee as % of output amount
  decimals: number;
}

/**
 * getBridgeQuote — Fetch a fee estimate from deBridge without broadcasting.
 *
 * Calls create-tx and reads the estimation fields from the response.
 * Use a representative amount (e.g. $100) to get a meaningful fee percentage.
 */
export async function getBridgeQuote(
  srcChainId: number,
  srcToken: string,
  dstChainId: number,
  dstToken: string,
  amount: string,
  srcAuthority: string,
  dstAuthority: string,
  route: string,
  decimals = 6,
): Promise<BridgeQuote> {
  const amountSmallest = BigInt(Math.round(parseFloat(amount) * 10 ** decimals)).toString();

  let res;
  try {
    res = await axios.get(`${DEBRIDGE_API}/dln/order/create-tx`, {
      params: {
        srcChainId,
        srcChainTokenIn: srcToken,
        srcChainTokenInAmount: amountSmallest,
        dstChainId,
        dstChainTokenOut: dstToken,
        dstChainTokenOutAmount: 'auto',
        dstChainTokenOutRecipient: dstAuthority,
        srcChainOrderAuthorityAddress: srcAuthority,
        dstChainOrderAuthorityAddress: dstAuthority,
        prependOperatingExpenses: true,
      },
      timeout: 15_000,
    });
  } catch (err: unknown) {
    const axErr = err as { response?: { status?: number; data?: unknown } };
    const detail = axErr.response?.data ? JSON.stringify(axErr.response.data) : String(err);
    throw new Error(`[wallet/bridge] quote failed (HTTP ${axErr.response?.status ?? '?'}): ${detail}`);
  }

  const est = res.data?.estimation;
  const inputRaw  = BigInt(est?.srcChainTokenIn?.amount  ?? amountSmallest);
  const outputRaw = BigInt(est?.dstChainTokenOut?.amount ?? 0);
  const factor    = 10n ** BigInt(decimals);

  const toDecimal = (raw: bigint) =>
    `${raw / factor}.${(raw % factor).toString().padStart(decimals, '0')}`;

  const inputDec  = toDecimal(inputRaw);
  const outputDec = toDecimal(outputRaw);
  const feeDec    = toDecimal(inputRaw - outputRaw);
  const feePct    = outputRaw > 0n
    ? (((inputRaw - outputRaw) * 10000n) / outputRaw / 100n).toString()
    : '?';

  return { route, inputAmount: inputDec, outputAmount: outputDec, feePaidByUser: feeDec, feePct: `${feePct}%`, decimals };
}

/**
 * getBridgeFees — Quote all active bridge routes at a given reference amount.
 *
 * Called by the agent's `get_bridge_fees` tool to understand current bridging
 * costs before making capital allocation decisions.
 *
 * Routes:
 *   - Tron USDT → Arbitrum USDT   (deBridge)
 *   - Base USDC → Arbitrum USDT   (deBridge)
 *   - Arbitrum USDT → Tron USDT   (Symbiosis — ~0.4%, cheaper than deBridge's ~$8 flat)
 *   - Arbitrum USDC → Base USDC   (deBridge)
 *
 * @param referenceAmountUsdt  Amount to use for the quote (default $100).
 */
export async function getBridgeFees(referenceAmountUsdt = '100'): Promise<BridgeQuote[]> {
  const [evmAddress, tronAddress] = await Promise.all([
    getAgentEvmAddress(),
    getAgentTronAddress(),
  ]);

  const routes = [
    getBridgeQuote(CHAIN_TRON, USDT_TRON, CHAIN_ARBITRUM, USDT_ARBITRUM, referenceAmountUsdt, tronAddress, evmAddress, 'Tron USDT → Arbitrum USDT'),
    getBridgeQuote(CHAIN_BASE, USDC_BASE, CHAIN_ARBITRUM, USDT_ARBITRUM, referenceAmountUsdt, evmAddress, evmAddress, 'Base USDC → Arbitrum USDT'),
    getSymbiosisBridgeQuote(referenceAmountUsdt, evmAddress, tronAddress),
    getBridgeQuote(CHAIN_ARBITRUM, USDC_ARBITRUM, CHAIN_BASE, USDC_BASE, referenceAmountUsdt, evmAddress, evmAddress, 'Arbitrum USDC → Base USDC'),
  ];

  const results = await Promise.allSettled(routes);
  return results
    .map((r, i) => r.status === 'fulfilled' ? r.value : {
      route: ['Tron USDT → Arbitrum USDT','Base USDC → Arbitrum USDT','Arbitrum USDT → Tron USDT (Symbiosis)','Arbitrum USDC → Base USDC'][i],
      inputAmount: '?', outputAmount: '?', feePaidByUser: '?', feePct: '?', decimals: 6,
      error: r.reason?.message ?? String(r.reason),
    } as unknown as BridgeQuote)
    .filter(Boolean);
}

/**
 * getSymbiosisBridgeQuote — Quote the Arbitrum USDT → Tron USDT fee via Symbiosis.
 * Read-only; does not broadcast.
 */
async function getSymbiosisBridgeQuote(
  amount: string,
  evmAddress: string,
  tronAddress: string,
): Promise<BridgeQuote> {
  const tronAddressHex = tronBase58ToEvmHex(tronAddress);
  const amountSmallest = BigInt(Math.round(parseFloat(amount) * 1_000_000)).toString();

  let res;
  try {
    res = await axios.post(`${SYMBIOSIS_API}/v1/swap`, {
      tokenAmountIn: { address: USDT_ARBITRUM, chainId: CHAIN_ARBITRUM, decimals: 6, amount: amountSmallest, symbol: 'USDT' },
      tokenOut: { address: USDT_TRON_HEX, chainId: CHAIN_TRON_SYMBIOSIS, decimals: 6, symbol: 'USDT' },
      from: evmAddress,
      to: tronAddressHex,
      slippage: 300,
    }, { timeout: 15_000 });
  } catch (err: unknown) {
    const axErr = err as { response?: { status?: number; data?: unknown } };
    const detail = axErr.response?.data ? JSON.stringify(axErr.response.data) : String(err);
    throw new Error(`[wallet/bridge] Symbiosis quote error (HTTP ${axErr.response?.status ?? '?'}): ${detail}`);
  }

  const factor = 1_000_000n;
  const inputRaw  = BigInt(amountSmallest);
  const outputRaw = BigInt(res.data?.tokenAmountOut?.amount ?? 0);

  const toDecimal = (raw: bigint) => `${raw / factor}.${(raw % factor).toString().padStart(6, '0')}`;
  const feePct = outputRaw > 0n
    ? ((inputRaw - outputRaw) * 10000n / outputRaw / 100n).toString()
    : '?';

  return {
    route: 'Arbitrum USDT → Tron USDT (Symbiosis)',
    inputAmount: toDecimal(inputRaw),
    outputAmount: toDecimal(outputRaw),
    feePaidByUser: toDecimal(inputRaw - outputRaw),
    feePct: `${feePct}%`,
    decimals: 6,
  };
}

// ---------------------------------------------------------------------------
// Internal: create + submit an order
// ---------------------------------------------------------------------------

interface OrderParams {
  srcChainId: number;
  srcChainTokenIn: string;
  srcChainTokenInAmount: string;
  dstChainId: number;
  dstChainTokenOut: string;
  dstChainTokenOutRecipient: string;
  srcChainOrderAuthorityAddress: string;
  dstChainOrderAuthorityAddress: string;
  description: string;
}

/**
 * createAndSubmitOrder — Fetch tx data from deBridge API, sign, and broadcast.
 *
 * For Tron source chain: uses TronWeb to sign and broadcast.
 * For EVM source chains (future use): would use ethers.
 */
async function createAndSubmitOrder(params: OrderParams): Promise<string> {
  // Convert decimal USDT amount to the chain's smallest unit (6 decimals for USDT/USDC).
  const amountInSmallestUnit = (BigInt(Math.round(parseFloat(params.srcChainTokenInAmount) * 1_000_000))).toString();

  // Fetch unsigned tx from deBridge API.
  const apiParams = {
    srcChainId: params.srcChainId,
    srcChainTokenIn: params.srcChainTokenIn,
    srcChainTokenInAmount: amountInSmallestUnit,
    dstChainId: params.dstChainId,
    dstChainTokenOut: params.dstChainTokenOut,
    dstChainTokenOutAmount: 'auto',
    dstChainTokenOutRecipient: params.dstChainTokenOutRecipient,
    srcChainOrderAuthorityAddress: params.srcChainOrderAuthorityAddress,
    dstChainOrderAuthorityAddress: params.dstChainOrderAuthorityAddress,
    prependOperatingExpenses: true,
  };
  console.log('[wallet/bridge] Requesting order:', JSON.stringify(apiParams));

  let res;
  try {
    res = await axios.get(`${DEBRIDGE_API}/dln/order/create-tx`, {
      params: apiParams,
      timeout: 15_000,
    });
  } catch (err: unknown) {
    const axErr = err as { response?: { status?: number; data?: unknown } };
    const detail = axErr.response?.data ? JSON.stringify(axErr.response.data) : String(err);
    throw new Error(`[wallet/bridge] deBridge API error (HTTP ${axErr.response?.status ?? '?'}): ${detail}`);
  }

  const orderId: string = res.data?.orderId ?? res.data?.estimation?.orderId;
  if (!orderId) {
    throw new Error(`[wallet/bridge] deBridge did not return an orderId. Response: ${JSON.stringify(res.data)}`);
  }

  const txData = res.data?.tx;
  if (!txData) {
    throw new Error(`[wallet/bridge] deBridge did not return tx data. Response: ${JSON.stringify(res.data)}`);
  }

  // Broadcast on source chain.
  if (params.srcChainId === CHAIN_TRON) {
    await broadcastTronBridgeTx(txData, params.srcChainOrderAuthorityAddress);
  } else {
    await broadcastEvmBridgeTx(txData, params.srcChainId, params.srcChainTokenIn);
  }

  console.log(`[wallet/bridge] ${params.description} — orderId: ${orderId}`);
  return orderId;
}

/**
 * broadcastTronBridgeTx — Sign and broadcast a Tron transaction returned by deBridge.
 *
 * deBridge returns a `tx` object for Tron with:
 *   { to: contractAddress, data: hexEncodedCalldata, feeLimit: sunAmount }
 */
async function broadcastTronBridgeTx(
  txData: { to: string; data: string; value?: string },
  fromAddress: string,
): Promise<void> {
  // Dynamic import to avoid circular dependency at module initialisation.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const TronWeb = require('tronweb');
  const { derivePrivateKey } = await importTronInternals();

  const tronGridUrl = process.env.TRON_RPC_URL ?? 'https://api.trongrid.io';
  const apiKey = process.env.TRON_API_KEY;

  const headers: Record<string, string> = {};
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;

  const privateKey = derivePrivateKey(0);
  const signerWeb = new TronWeb({ fullHost: tronGridUrl, headers, privateKey });

  // deBridge DLN contract call on Tron — use triggerSmartContract with raw calldata.
  const { transaction } = await signerWeb.transactionBuilder.triggerSmartContract(
    txData.to,
    '', // function selector is embedded in txData.data
    {
      feeLimit: 150_000_000,
      callValue: parseInt(txData.value ?? '0', 16) || 0,
      from: fromAddress,
      // Pass raw calldata directly when deBridge returns encoded data.
      rawParameter: txData.data?.startsWith('0x') ? txData.data.slice(2) : txData.data,
    },
    [],
    fromAddress,
  );

  const signed = await signerWeb.trx.sign(transaction, privateKey);
  const result = await signerWeb.trx.sendRawTransaction(signed);
  if (!result.result) {
    throw new Error(`[wallet/bridge] Tron broadcast failed: ${JSON.stringify(result)}`);
  }
}

/**
 * broadcastEvmBridgeTx — Approve token spend and broadcast a deBridge EVM transaction.
 *
 * deBridge returns EVM transactions as { to, data, value } objects. For ERC-20
 * source tokens the contract pulls the tokens itself, so we must approve it first.
 *
 * @param txData      Transaction data returned by the deBridge API
 * @param chainId     Source chain ID (used to select the right signer)
 * @param tokenIn     ERC-20 address of the token being bridged (to approve)
 */
async function broadcastEvmBridgeTx(
  txData: { to: string; data: string; value?: string },
  chainId: number,
  tokenIn: string,
  /** Address to approve for token spend. Defaults to txData.to. Symbiosis needs approveTo ≠ tx.to. */
  approveTo?: string,
): Promise<string> {
  const { ethers } = await import('ethers');
  const { getSigner } = await import('./evm');

  const chain = chainId === CHAIN_BASE ? 'base' : 'arbitrum';
  const signer = getSigner(chain);

  const erc20Abi = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ];

  // Native ETH needs no approval — skip for zero address.
  if (tokenIn !== NATIVE_ETH) {
    const spender = approveTo ?? txData.to;
    const token = new ethers.Contract(tokenIn, erc20Abi, signer);
    const approveTx = await (token.approve as (spender: string, amount: bigint) => Promise<{ wait: () => Promise<unknown> }>)(
      spender,
      ethers.MaxUint256,
    );
    await approveTx.wait();
    console.log(`[wallet/bridge] ERC-20 approval confirmed for ${tokenIn} → ${spender}`);
  }

  // Broadcast the deBridge order transaction.
  const value = txData.value ? BigInt(txData.value) : 0n;
  const bridgeTx = await signer.sendTransaction({
    to: txData.to,
    data: txData.data,
    value,
  });
  await bridgeTx.wait();
  console.log(`[wallet/bridge] EVM bridge tx confirmed: ${bridgeTx.hash}`);
  return bridgeTx.hash;
}

/**
 * importTronInternals — Access private tron.ts functions needed for bridging.
 *
 * We expose derivePrivateKey via a dedicated internal export only used by bridge.ts.
 * This keeps the private key confined to wallet/* modules.
 */
async function importTronInternals(): Promise<{ derivePrivateKey: (index: number) => string }> {
  // This works because tron.ts declares derivePrivateKey in module scope.
  // For bridge.ts we need index 0 only; we wrap it to avoid broad exposure.
  const tronModule = await import('./tron');
  // getAgentTrxBalance is a public function; use it as a liveness check.
  // The actual private key access goes through the module's internal scope.
  // Since JS modules share scope, we call forwardPayment with a 0-amount trick is wrong.
  // Instead: we re-derive from mnemonic here via ethers HDNode.

  // Fallback: derive via ethers using same mnemonic, EVM path (coin type 195 for Tron).
  // This avoids needing to export the private key from tron.ts.
  const { ethers } = await import('ethers');
  const seed = process.env.WDK_SEED_PHRASE;
  if (!seed) throw new Error('[wallet/bridge] WDK_SEED_PHRASE not set');

  // Use TRON BIP-44 path m/44'/195'/0'/0/0 to derive the same key as tron.ts.
  // ethers.HDNodeWallet.fromPhrase follows BIP-44 derivation.
  const hdWallet = ethers.HDNodeWallet.fromPhrase(seed, undefined, "m/44'/195'/0'/0/0");
  const privKey = hdWallet.privateKey.replace(/^0x/, ''); // TronWeb wants raw hex

  void tronModule; // imported only for side-effect (ensure wallet is initialised)

  return { derivePrivateKey: (_index: number) => privKey };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * tronBase58ToEvmHex — Convert a Tron base58check address to EVM hex format.
 *
 * Tron addresses are 21 bytes: one prefix byte (0x41) + 20-byte EVM address.
 * TronWeb.address.toHex returns "41<40-hex-chars>"; we strip the "41" and prepend "0x".
 * Symbiosis expects the 20-byte hex form.
 */
function tronBase58ToEvmHex(base58: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const TronWeb = require('tronweb');
  const hex: string = TronWeb.address.toHex(base58); // "41xxxxxxxx..." (42 hex chars)
  return '0x' + hex.slice(2); // strip "41" prefix → 20-byte EVM address
}

function mapDlnStatus(raw: string | undefined): BridgeOrderStatus {
  if (!raw) return 'unknown';
  const s = raw.toLowerCase();
  if (s.includes('fulfilled') || s.includes('claimed')) return 'fulfilled';
  if (s.includes('unlock')) return 'sentUnlock';
  if (s.includes('cancel')) return 'orderCancelled';
  if (s.includes('created') || s.includes('pending')) return 'created';
  return 'unknown';
}
