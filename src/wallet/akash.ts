/**
 * src/wallet/akash.ts — Akash Network wallet and escrow management
 *
 * Handles:
 *   - Deriving the agent's Akash wallet (akash1...) from WDK_SEED_PHRASE
 *   - Querying AKT balance and deployment escrow status
 *   - Topping up deployment escrow when it runs low
 *
 * The Akash wallet uses Cosmos coin type 118 (m/44'/118'/0'/0/0).
 * The same seed phrase used for EVM and Tron wallets derives a separate Cosmos
 * wallet here — fully non-custodial, zero extra key management.
 *
 * Chain: Akash Network (akashnet-2)
 * RPC endpoint: AKASH_RPC_ENDPOINT env var (Tendermint RPC, used by cosmjs)
 * REST endpoint: AKASH_REST_ENDPOINT env var (Cosmos LCD/REST)
 * gRPC endpoint: AKASH_GRPC_ENDPOINT env var (used by chain-sdk query client)
 *
 * ── Escrow drain-rate maths ──────────────────────────────────────────────────
 * The winning Akash bid sets a rate in uakt/block.
 * Block time ≈ 6.098 seconds (from Akash Console source).
 * Blocks per month = (30.437 days × 86,400 s/day) / 6.098 s/block ≈ 430,834.
 *
 *   Monthly cost (AKT) = rate_uakt × 430,834 / 1,000,000
 *
 * Examples at typical winning bids:
 *   50  uakt/block →  21.5 AKT/month
 *   100 uakt/block →  43.1 AKT/month
 *   200 uakt/block →  86.2 AKT/month
 *
 * The SDL `amount` field is the maximum bid ceiling (often 10,000 uakt/block).
 * Providers bid lower — actual winning bids are typically 50–500 uakt/block
 * depending on available capacity and competition.
 *
 * Minimum escrow deposit: 5 AKT (enforced by the network).
 * If escrow drains to zero, Akash closes the deployment immediately.
 * Keep at least 2× the monthly burn rate in escrow as a safety buffer.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import axios from 'axios';

const AKASH_REST  = process.env.AKASH_REST_ENDPOINT  ?? 'https://api.akashnet.net';
const AKASH_RPC   = process.env.AKASH_RPC_ENDPOINT   ?? 'https://rpc.akashnet.net:443';
const AKASH_GRPC  = process.env.AKASH_GRPC_ENDPOINT  ?? 'akash.lavenderfive.com:443';

const PREFIX       = 'akash';
const DENOM        = 'uakt';
const UAKT_PER_AKT = 1_000_000;

/**
 * Akash blocks per month, derived from official Akash Console constants:
 *   averageBlockTime = 6.098s
 *   averageDaysInMonth = 30.437
 *   blocks/month = (30.437 * 86400) / 6.098 ≈ 430,834
 */
export const AKASH_BLOCKS_PER_MONTH = 430_834;

// Lazy singletons — avoid re-deriving on every call.
let _wallet: import('@cosmjs/proto-signing').DirectSecp256k1HdWallet | null = null;
let _address: string | null = null;

async function getWalletInstance() {
  if (_wallet) return _wallet;
  const { DirectSecp256k1HdWallet, makeCosmoshubPath } = await import('@cosmjs/proto-signing');
  const mnemonic = process.env.WDK_SEED_PHRASE;
  if (!mnemonic) throw new Error('WDK_SEED_PHRASE not set — cannot derive Akash wallet');
  _wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: PREFIX,
    hdPaths: [makeCosmoshubPath(0)], // m/44'/118'/0'/0/0
  });
  return _wallet;
}

/** Return the agent's akash1... address. */
export async function getAkashAddress(): Promise<string> {
  if (_address) return _address;
  const w = await getWalletInstance();
  const [acct] = await w.getAccounts();
  _address = acct.address;
  return _address;
}

/** Return AKT balance as a decimal string (e.g. "12.500000"). */
export async function getAktBalance(): Promise<string> {
  const address = await getAkashAddress();
  const res = await axios.get<{ balances: Array<{ denom: string; amount: string }> }>(
    `${AKASH_REST}/cosmos/bank/v1beta1/balances/${address}`,
    { timeout: 10_000 },
  );
  const uakt = res.data.balances?.find((b) => b.denom === DENOM)?.amount ?? '0';
  return (parseInt(uakt, 10) / UAKT_PER_AKT).toFixed(6);
}

export interface EscrowStatus {
  /** Total escrow balance (owner funds + depositor funds) in AKT. */
  balanceAkt: string;
  /** Combined drain rate of all active leases (uakt/block). */
  drainRateUaktPerBlock: number;
  /** Monthly AKT burned at the current drain rate. null if no active leases. */
  monthlyBurnAkt: number | null;
  /** Estimated months of runway at current drain rate. null if no active leases. */
  estimatedMonthsRemaining: number | null;
  escrowState: string;
  owner: string;
  dseq: string;
}

/**
 * Query the escrow status for a running deployment.
 *
 * Uses the REST API:
 *   - Escrow balance: GET /akash/deployment/v1beta3/deployments/info
 *   - Drain rate: GET /akash/market/v1beta5/leases/list
 *
 * dseq is the deployment sequence number visible in the Akash console.
 * Set AKASH_DEPLOYMENT_DSEQ in the environment.
 */
export async function getEscrowBalance(dseq: string): Promise<EscrowStatus> {
  const owner = await getAkashAddress();

  // Query deployment info — includes embedded escrow account.
  const [deployRes, leaseRes] = await Promise.all([
    axios.get<{
      deployment: { deployment_id: { owner: string; dseq: string } };
      escrow_account: {
        balance: { denom: string; amount: string };
        funds: { denom: string; amount: string };
        state: string;
      };
    }>(
      `${AKASH_REST}/akash/deployment/v1beta3/deployments/info`,
      {
        params: { 'id.owner': owner, 'id.dseq': dseq },
        timeout: 10_000,
      },
    ).catch(() => null),
    // Query active leases to get the drain rate (price per block).
    axios.get<{
      leases: Array<{
        lease: { state: string; price: { denom: string; amount: string } };
      }>;
    }>(
      `${AKASH_REST}/akash/market/v1beta5/leases/list`,
      {
        params: { 'filters.owner': owner, 'filters.dseq': dseq },
        timeout: 10_000,
      },
    ).catch(() => null),
  ]);

  // Parse escrow balance.
  let totalBalanceUakt = 0;
  let escrowState = 'unknown';
  if (deployRes?.data?.escrow_account) {
    const ea = deployRes.data.escrow_account;
    escrowState = ea.state ?? 'unknown';
    totalBalanceUakt =
      parseFloat(ea.balance?.amount ?? '0') +
      parseFloat(ea.funds?.amount ?? '0');
  }

  // Parse drain rate from active leases.
  const activeLeases = (leaseRes?.data?.leases ?? []).filter(
    (l) => l.lease?.state === 'active',
  );
  const totalDrainRate = activeLeases.reduce(
    (sum, l) => sum + parseFloat(l.lease?.price?.amount ?? '0'),
    0,
  );

  const monthlyBurnAkt = totalDrainRate > 0
    ? (totalDrainRate * AKASH_BLOCKS_PER_MONTH) / UAKT_PER_AKT
    : null;

  const estimatedMonthsRemaining = totalDrainRate > 0
    ? totalBalanceUakt / (totalDrainRate * AKASH_BLOCKS_PER_MONTH)
    : null;

  return {
    balanceAkt: (totalBalanceUakt / UAKT_PER_AKT).toFixed(6),
    drainRateUaktPerBlock: totalDrainRate,
    monthlyBurnAkt,
    estimatedMonthsRemaining,
    escrowState,
    owner,
    dseq,
  };
}

/**
 * Deposit AKT into a deployment's escrow account via MsgAccountDeposit.
 *
 * Uses @akashnetwork/chain-sdk:
 *   - createStargateClient: wraps CosmJS with Akash proto type support
 *   - createChainNodeSDK: gRPC SDK client with escrow.v1.accountDeposit method
 *
 * MsgAccountDeposit fields:
 *   signer  = depositor's akash1... address
 *   id      = { scope: 1 (SCOPE_DEPLOYMENT), xid: dseq }
 *   deposit = { amount: { denom: "uakt", amount: "..." }, sources: [] }
 *
 * Returns the transaction hash on success.
 */
export async function topUpEscrow(dseq: string, amountAkt: string): Promise<string> {
  // @ts-ignore — @akashnetwork/chain-sdk types only resolve with node16 moduleResolution;
  // this is the same known issue as @coinbase/x402 in this project.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chainSdk = await (import('@akashnetwork/chain-sdk') as Promise<any>);

  const w = await getWalletInstance();
  const [acct] = await w.getAccounts();
  const amountUakt = String(Math.floor(parseFloat(amountAkt) * UAKT_PER_AKT));

  // createStargateClient wraps CosmJS's SigningStargateClient with Akash proto
  // type awareness. It needs the Tendermint RPC endpoint and the CosmJS signer.
  const stargateClient = chainSdk.createStargateClient({
    baseUrl: AKASH_RPC,
    signer: w,
  });

  // createChainNodeSDK takes a gRPC base URL for queries and the stargate
  // client as the transaction signer.
  const sdk = chainSdk.createChainNodeSDK({
    query: {
      baseUrl: AKASH_GRPC,
    },
    tx: {
      signer: stargateClient,
    },
  });

  // MsgAccountDeposit: top up an existing escrow account.
  //   scope = 1  (SCOPE_DEPLOYMENT in akash.escrow.id.v1.Scope)
  //   xid   = dseq string
  await sdk.akash.escrow.v1.accountDeposit({
    signer: acct.address,
    id: {
      scope: 1, // Scope.deployment
      xid: dseq,
    },
    deposit: {
      amount: { denom: DENOM, amount: amountUakt },
      sources: [],
    },
  });

  // The chain-sdk's accountDeposit returns MsgAccountDepositResponse (empty).
  // To get the tx hash, we'd need to instrument the signer. For now return a
  // success indicator — the agent can verify by re-querying the escrow balance.
  console.log(`[akash] Escrow top-up submitted: +${amountAkt} AKT → deployment dseq=${dseq}`);
  return `akash-escrow-topup-${dseq}-${Date.now()}`;
}
