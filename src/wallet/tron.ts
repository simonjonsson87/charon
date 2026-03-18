/**
 * src/wallet/tron.ts — TRON wallet module
 *
 * All TRON key material is managed here. The seed phrase is read from the
 * WDK_SEED_PHRASE environment variable at initialisation time and is NEVER
 * passed outside this module. Signing happens locally; private keys never
 * leave this process.
 *
 * HD derivation path: m/44'/195'/{index}'/0/0  (TRON BIP-44 coin type 195)
 *
 * Implementation: uses TronWeb v5 (already in package.json) directly.
 * TronWeb 5.x includes HD wallet derivation via fromMnemonic().
 * When @tetherto/wdk-wallet-tron becomes available, the internals of this
 * module can be swapped out without changing any callers.
 *
 * Design: all public functions are async — this allows transparent swapping
 * to remote signing or HSM support in future without changing callers.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TronWeb = require('tronweb');
import axios from 'axios';

// USDT TRC-20 contract — override via env to use a test token on Shasta.
// NOTE: Shasta testnet has no official USDT. Deploy a test TRC-20 and set its address here.
const USDT_CONTRACT = process.env.TRON_USDT_CONTRACT ?? 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// SunSwap v2 — not deployed on Shasta. Set env var to empty string to disable swaps on testnet.
const SUNSWAP_V2_ROUTER = process.env.TRON_SUNSWAP_ROUTER ?? 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax';
const WTRX_CONTRACT     = process.env.TRON_WTRX_CONTRACT  ?? 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR';

// TRON BIP-44 derivation path (coin type 195)
const TRON_BIP44_PATH = (index: number) => `m/44'/195'/${index}'/0/0`;

// TronGrid base URL and API key (set at init)
let tronGridUrl = 'https://api.trongrid.io';
let apiKey: string | undefined;

// Root TronWeb instance (no signing key — used for read-only calls)
let tronWeb: typeof TronWeb | null = null;

// Mnemonic stored in memory for key derivation
let mnemonic: string | null = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * initTronWallet — Boot the TRON wallet from the environment seed.
 *
 * Must be called once at startup (src/index.ts) before any other function
 * in this module. Throws if WDK_SEED_PHRASE is not set.
 */
export async function initTronWallet(): Promise<void> {
  const seed = process.env.WDK_SEED_PHRASE;
  if (!seed) {
    throw new Error('[wallet/tron] WDK_SEED_PHRASE environment variable is not set.');
  }

  tronGridUrl = process.env.TRON_RPC_URL ?? 'https://api.trongrid.io';
  apiKey = process.env.TRON_API_KEY;

  const headers: Record<string, string> = {};
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;

  tronWeb = new TronWeb({
    fullHost: tronGridUrl,
    headers,
  });

  mnemonic = seed;
  console.log('[wallet/tron] Wallet initialised.');
}

// ---------------------------------------------------------------------------
// Address derivation
// ---------------------------------------------------------------------------

/**
 * deriveAddress — Derive the TRON address at the given HD index.
 *
 * Deterministic: the same index always produces the same address for a given
 * seed. Index 0 is the agent's "hot" address used for receiving and forwarding.
 * Indexes 1..N are used for the payment address pool.
 */
export async function deriveAddress(index: number): Promise<string> {
  if (!tronWeb || !mnemonic) throw new Error('[wallet/tron] Wallet not initialised.');

  const account = TronWeb.fromMnemonic(mnemonic, TRON_BIP44_PATH(index));
  return account.address;
}

/**
 * getTronWalletAddress — Convenience alias for the agent's primary address (index 0).
 */
export async function getTronWalletAddress(index: number = 0): Promise<string> {
  return deriveAddress(index);
}

/** Derive the private key at the given HD index (kept internal). */
function derivePrivateKey(index: number): string {
  if (!mnemonic) throw new Error('[wallet/tron] Wallet not initialised.');
  const account = TronWeb.fromMnemonic(mnemonic, TRON_BIP44_PATH(index));
  // TronWeb.fromMnemonic returns an ethers-style key with 0x prefix.
  // TronWeb constructor requires raw hex (no 0x prefix).
  return (account.privateKey as string).replace(/^0x/, '');
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/**
 * getBalance — Get the USDT TRC-20 balance for any TRON address.
 *
 * Returns the balance as a decimal string (e.g., "123.456789").
 * USDT on TRON has 6 decimal places.
 */
export async function getBalance(address: string): Promise<string> {
  if (!tronWeb) throw new Error('[wallet/tron] Wallet not initialised.');

  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;

    // Use TronGrid v1 REST API for TRC-20 balance (more reliable than triggerConstantContract).
    const res = await axios.get(
      `${tronGridUrl}/v1/accounts/${address}`,
      { headers, timeout: 5000 },
    );

    const trc20Balances: Record<string, string>[] = res.data?.data?.[0]?.trc20 ?? [];
    const usdtEntry = trc20Balances.find((b) => b[USDT_CONTRACT] !== undefined);
    const rawBalance = usdtEntry ? parseInt(usdtEntry[USDT_CONTRACT]!, 10) : 0;

    return (rawBalance / 1_000_000).toFixed(6);
  } catch (err) {
    console.error(`[wallet/tron] getBalance(${address}) failed:`, err);
    return '0.000000';
  }
}

// ---------------------------------------------------------------------------
// Event watching
// ---------------------------------------------------------------------------

export type TronTransferEvent = {
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: string; // decimal string, 6dp
  blockNumber: number;
  timestamp: number;
};

/**
 * watchAddress — Reserved for future WebSocket-based event subscription.
 *
 * The actual event-watching logic lives in src/relay/monitor.ts, which calls
 * getTransferEvents() directly in its polling loop.
 */
export function watchAddress(
  address: string,
  _callback: (event: TronTransferEvent) => void,
): () => void {
  console.warn(`[wallet/tron] watchAddress(${address}) — using polling monitor instead.`);
  return () => {};
}

/**
 * getTransferEvents — Fetch recent USDT TRC-20 inbound transfers for an address.
 *
 * Calls the TronGrid v1 TRC-20 transactions endpoint, filtered to the USDT
 * contract. Returns only transfers where `to == address`.
 *
 * `sinceTimestamp` is a Unix millisecond timestamp; only events after this
 * time are returned, preventing duplicate processing across poll cycles.
 */
export async function getTransferEvents(
  address: string,
  sinceTimestamp: number,
): Promise<TronTransferEvent[]> {
  if (!tronWeb) throw new Error('[wallet/tron] Wallet not initialised.');

  const headers: Record<string, string> = {};
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;

  try {
    const res = await axios.get(
      `${tronGridUrl}/v1/accounts/${address}/transactions/trc20`,
      {
        headers,
        params: {
          only_confirmed: true,
          contract_address: USDT_CONTRACT,
          limit: 200,
          min_timestamp: sinceTimestamp,
        },
        timeout: 8000,
      },
    );

    type TronGridTx = {
      transaction_id: string;
      from: string;
      to: string;
      value: string;
      block_timestamp: number;
      token_info?: { decimals?: number };
    };

    const txs: TronGridTx[] = res.data?.data ?? [];

    return txs
      .filter((tx) => tx.to.toLowerCase() === address.toLowerCase())
      .map((tx) => ({
        txHash: tx.transaction_id,
        fromAddress: tx.from,
        toAddress: tx.to,
        amount: (parseInt(tx.value, 10) / 1_000_000).toFixed(6),
        blockNumber: 0, // not returned by this endpoint; use tx receipt if needed
        timestamp: tx.block_timestamp,
      }));
  } catch (err) {
    console.error(`[wallet/tron] getTransferEvents(${address}) failed:`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// SunSwap v2 — USDT → TRX swap (for energy reserve top-up)
// ---------------------------------------------------------------------------

/**
 * swapUsdtForTrx — Swap USDT for native TRX using SunSwap v2 on Tron.
 *
 * Used by the agent to top up the TRX energy-sponsorship reserve when it runs low.
 * Calls `swapExactTokensForETH` on the SunSwap v2 Router (Uniswap v2 fork).
 * Both USDT and WTRX use 6 decimals on Tron.
 *
 * Steps:
 *   1. Approve the router to spend `amountUsdt` of USDT.
 *   2. Call swapExactTokensForETH — router converts USDT→WTRX, unwraps to TRX.
 *
 * @param amountUsdt  Amount to swap as a decimal string, e.g. "5.000000"
 * @param slippagePct Maximum acceptable slippage percentage (default 1.0)
 * @returns           TRX received as a decimal string
 */
export async function swapUsdtForTrx(
  amountUsdt: string,
  slippagePct = 1.0,
): Promise<string> {
  if (!tronWeb || !mnemonic) throw new Error('[wallet/tron] Wallet not initialised.');

  const privateKey = derivePrivateKey(0);
  const fromAddress = await deriveAddress(0);

  const headers: Record<string, string> = {};
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;

  const signerWeb = new TronWeb({ fullHost: tronGridUrl, headers, privateKey });

  const amountIn = Math.round(parseFloat(amountUsdt) * 1_000_000); // 6 decimals
  const deadlineTs = Math.floor(Date.now() / 1000) + 300; // 5 min TTL

  // Step 1: approve router to spend USDT.
  const { transaction: approveTx } = await signerWeb.transactionBuilder.triggerSmartContract(
    USDT_CONTRACT,
    'approve(address,uint256)',
    { feeLimit: 50_000_000, callValue: 0, from: fromAddress },
    [
      { type: 'address', value: SUNSWAP_V2_ROUTER },
      { type: 'uint256', value: amountIn },
    ],
    fromAddress,
  );
  const signedApprove = await signerWeb.trx.sign(approveTx, privateKey);
  const approveResult = await signerWeb.trx.sendRawTransaction(signedApprove);
  if (!approveResult.result) {
    throw new Error(`[wallet/tron] USDT approve failed: ${JSON.stringify(approveResult)}`);
  }

  // Wait one block for approval to confirm (~3s on Tron mainnet).
  await new Promise((r) => setTimeout(r, 3500));

  const path = [USDT_CONTRACT, WTRX_CONTRACT];

  // Step 2: get expected output from SunSwap router (read-only, no gas cost).
  // triggerConstantContract executes the view function on TronGrid without broadcasting.
  const quoteResult = await signerWeb.transactionBuilder.triggerConstantContract(
    SUNSWAP_V2_ROUTER,
    'getAmountsOut(uint256,address[])',
    {},
    [
      { type: 'uint256', value: amountIn },
      { type: 'address[]', value: path },
    ],
    fromAddress,
  );

  // ABI-decode uint256[] return: [offset(32b), length(32b), amounts[0](32b), amounts[1](32b)]
  // amounts[1] is the expected TRX output (in sun, 6 decimals), starting at byte offset 96.
  const hex: string = quoteResult.constant_result?.[0] ?? '';
  if (hex.length < 256) {
    throw new Error(`[wallet/tron] SunSwap getAmountsOut returned unexpected data: ${hex}`);
  }
  const amountOutExpected = BigInt('0x' + hex.slice(192, 256));

  // Apply slippage tolerance: amountOutMin = expected × (100 - slippagePct) / 100
  const amountOutMin = amountOutExpected * BigInt(Math.round((100 - slippagePct) * 100)) / BigInt(10000);

  const { transaction: swapTx } = await signerWeb.transactionBuilder.triggerSmartContract(
    SUNSWAP_V2_ROUTER,
    'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
    { feeLimit: 150_000_000, callValue: 0, from: fromAddress },
    [
      { type: 'uint256', value: amountIn },
      { type: 'uint256', value: amountOutMin },
      { type: 'address[]', value: path },
      { type: 'address', value: fromAddress },
      { type: 'uint256', value: deadlineTs },
    ],
    fromAddress,
  );

  const signedSwap = await signerWeb.trx.sign(swapTx, privateKey);
  const swapResult = await signerWeb.trx.sendRawTransaction(signedSwap);
  if (!swapResult.result) {
    throw new Error(`[wallet/tron] SunSwap swap failed: ${JSON.stringify(swapResult)}`);
  }

  const txHash: string = swapResult.txid ?? swapResult.transaction?.txID;
  console.log(`[wallet/tron] SunSwap: ${amountUsdt} USDT → TRX. TX: ${txHash}`);

  // Return swap tx hash so the caller can display it. Actual TRX received
  // can be read from the agent's TRX balance after confirmation.
  return txHash;
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

/**
 * forwardPayment — Sweep USDT from a payment address to the developer's receiving address.
 *
 * Signs a TRC-20 transfer from the derived key at `fromIndex` to `toAddress`
 * for the net `amount`. Returns the broadcast transaction hash.
 *
 * The sweep is initiated only after REQUIRED_CONFIRMATIONS (see monitor.ts).
 * Energy for this transaction is pre-sponsored by relay/gasless.ts.
 */
export async function forwardPayment(
  fromIndex: number,
  toAddress: string,
  amount: string, // decimal string, e.g. "9.970000"
): Promise<string> {
  if (!tronWeb) throw new Error('[wallet/tron] Wallet not initialised.');

  const privateKey = derivePrivateKey(fromIndex);
  const fromAddress = await deriveAddress(fromIndex);

  // Amount in USDT's base unit (6 decimals)
  const amountSun = Math.round(parseFloat(amount) * 1_000_000);

  // Build a TronWeb instance with the sender's private key for signing.
  const headers: Record<string, string> = {};
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;

  const signerWeb = new TronWeb({
    fullHost: tronGridUrl,
    headers,
    privateKey,
  });

  try {
    // triggerSmartContract builds the raw transaction
    const { transaction } = await signerWeb.transactionBuilder.triggerSmartContract(
      USDT_CONTRACT,
      'transfer(address,uint256)',
      {
        feeLimit: 100_000_000, // 100 TRX max (never reached; energy is pre-sponsored)
        callValue: 0,
        from: fromAddress,
      },
      [
        { type: 'address', value: toAddress },
        { type: 'uint256', value: amountSun },
      ],
      fromAddress,
    );

    const signed = await signerWeb.trx.sign(transaction, privateKey);
    const result = await signerWeb.trx.sendRawTransaction(signed);

    if (!result.result) {
      throw new Error(`Broadcast rejected: ${JSON.stringify(result)}`);
    }

    const txHash: string = result.txid ?? result.transaction?.txID;
    console.log(`[wallet/tron] Forwarded ${amount} USDT from idx=${fromIndex} → ${toAddress}. TX: ${txHash}`);
    return txHash;
  } catch (err) {
    console.error(`[wallet/tron] forwardPayment failed:`, err);
    throw err;
  }
}
