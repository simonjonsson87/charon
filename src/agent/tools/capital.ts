/**
 * src/agent/tools/capital.ts — Agent tools: capital allocation
 *
 * These functions are the execution layer for capital allocation decisions.
 * The reasoning about WHEN and HOW MUCH to deposit or withdraw lives in
 * AGENTS.md as instructions to the agent. These tools just execute.
 *
 * Capital allocation philosophy (from AGENTS.md):
 *   - Keep AAVE_MIN_FLOAT_DAYS × avg_daily_volume as liquid USDT.
 *   - Deploy the rest to Aave to earn yield.
 *   - Never withdraw from Aave for speculative reasons — only for operational needs.
 *   - TRX reserve is separate; top it up from USDT via a swap if it falls low.
 *
 * These tools are thin wrappers around the wallet modules. They add:
 *   - Input validation
 *   - Pre/post balance logging for audit
 *   - A summary object returned for the agent to include in its reasoning
 */

import { deposit, withdraw, getDepositedBalance, getCurrentApy } from '../../wallet/aave';
import { getBridgeFees } from '../../wallet/bridge';
import type { BridgeQuote } from '../../wallet/bridge';
import type { AaveAsset } from '../../wallet/aave';
import { getUsdtBalance, getUsdcBalance, getEthBalance } from '../../wallet/evm';
import { getAgentTrxBalance } from '../../wallet/tronGasfree';
import { getBalance as getTronUsdtBalance, getTronWalletAddress } from '../../wallet/tron';

// ---------------------------------------------------------------------------
// Tool: get_capital_summary
// ---------------------------------------------------------------------------

export interface CapitalSummary {
  liquidUsdtArbitrum: string;
  liquidUsdcArbitrum: string;
  ethArbitrum: string;
  liquidUsdcBase: string;
  ethBase: string;
  liquidUsdtTron: string;
  aaveUsdtDeposited: string;
  aaveUsdcDeposited: string;
  trxReserve: string;
  aaveUsdtApyPercent: string;
  aaveUsdcApyPercent: string;
  totalUsdEquivalent: string;
}

/**
 * getCapitalSummary — Return a snapshot of all capital positions.
 *
 * Called by the agent as `get_capital_summary`. Used at the start of any
 * capital allocation decision to understand the current state.
 */
export async function getCapitalSummary(): Promise<CapitalSummary> {
  const tronAddress = await getTronWalletAddress(0);

  const [
    liquidUsdtArb,
    liquidUsdcArb,
    ethArb,
    liquidUsdcBase,
    ethBase,
    liquidUsdtTron,
    aaveUsdtBalance,
    aaveUsdcBalance,
    trxReserve,
    aaveUsdtApy,
    aaveUsdcApy,
  ] = await Promise.all([
    getUsdtBalance('arbitrum'),
    getUsdcBalance('arbitrum'),
    getEthBalance('arbitrum'),
    getUsdcBalance('base'),
    getEthBalance('base'),
    getTronUsdtBalance(tronAddress),
    getDepositedBalance('usdt'),
    getDepositedBalance('usdc'),
    getAgentTrxBalance(),
    getCurrentApy('usdt'),
    getCurrentApy('usdc'),
  ]);

  const total = (
    parseFloat(liquidUsdtArb) +
    parseFloat(liquidUsdcArb) +
    parseFloat(liquidUsdcBase) +
    parseFloat(liquidUsdtTron) +
    parseFloat(aaveUsdtBalance) +
    parseFloat(aaveUsdcBalance)
    // ETH and TRX not included — not USDT-equivalent, treat as operational reserves
  ).toFixed(2);

  return {
    liquidUsdtArbitrum: liquidUsdtArb,
    liquidUsdcArbitrum: liquidUsdcArb,
    ethArbitrum: ethArb,
    liquidUsdcBase,
    ethBase,
    liquidUsdtTron,
    aaveUsdtDeposited: aaveUsdtBalance,
    aaveUsdcDeposited: aaveUsdcBalance,
    trxReserve,
    aaveUsdtApyPercent: aaveUsdtApy,
    aaveUsdcApyPercent: aaveUsdcApy,
    totalUsdEquivalent: total,
  };
}

// ---------------------------------------------------------------------------
// Tool: deposit_to_aave
// ---------------------------------------------------------------------------

export interface AaveOperationResult {
  action: 'deposit' | 'withdraw';
  amount: string;
  txHash: string;
  balanceBefore: string;
  balanceAfter: string;
}

/**
 * depositToAave — Deposit USDT from the liquid balance into Aave.
 *
 * Called by the agent as `deposit_to_aave`. The agent must verify that:
 *   - The amount does not reduce liquid USDT below the minimum float.
 *   - The Aave APY justifies locking up the capital.
 *
 * The tool validates that the requested amount does not exceed the current
 * liquid balance, but defers the strategic decision to the agent.
 */
// Shared implementation — validates liquid balance then executes supply.
async function _depositToAave(amount: string, asset: AaveAsset): Promise<AaveOperationResult> {
  const ticker = asset.toUpperCase();
  const liquidBefore = asset === 'usdc'
    ? await getUsdcBalance('arbitrum')
    : await getUsdtBalance('arbitrum');
  const liquidNum = parseFloat(liquidBefore);
  const depositNum = parseFloat(amount);

  if (depositNum > liquidNum) {
    throw new Error(`Cannot deposit ${amount} ${ticker} — only ${liquidBefore} ${ticker} available.`);
  }
  if (depositNum < 1) {
    throw new Error(`Minimum Aave deposit is 1 ${ticker}.`);
  }

  const balanceBefore = await getDepositedBalance(asset);
  const txHash = await deposit(amount, asset);
  const balanceAfter = await getDepositedBalance(asset);

  console.log(`[tools/capital] Deposited ${amount} ${ticker} to Aave. Position: ${balanceBefore} → ${balanceAfter}`);
  return { action: 'deposit', amount, txHash, balanceBefore, balanceAfter };
}

export async function depositToAave(amountUsdt: string): Promise<AaveOperationResult> {
  return _depositToAave(amountUsdt, 'usdt');
}

export async function depositUsdcToAave(amountUsdc: string): Promise<AaveOperationResult> {
  return _depositToAave(amountUsdc, 'usdc');
}

// ---------------------------------------------------------------------------
// Tool: withdraw_from_aave
// ---------------------------------------------------------------------------

/**
 * withdrawFromAave — Withdraw USDT from Aave back to liquid balance.
 *
 * Called by the agent as `withdraw_from_aave`. Pass 'MAX' to withdraw
 * the entire position. The agent should only withdraw for operational
 * reasons (float replenishment, TRX reserve top-up funding) — never
 * for speculative purposes.
 */
// Shared implementation — validates deposited balance then executes withdrawal.
async function _withdrawFromAave(amount: string, asset: AaveAsset): Promise<AaveOperationResult> {
  const ticker = asset.toUpperCase();
  const balanceBefore = await getDepositedBalance(asset);
  const balanceNum = parseFloat(balanceBefore);

  if (amount !== 'MAX') {
    const withdrawNum = parseFloat(amount);
    if (withdrawNum > balanceNum) {
      throw new Error(`Cannot withdraw ${amount} ${ticker} — only ${balanceBefore} ${ticker} deposited.`);
    }
  }

  const txHash = await withdraw(amount, asset);
  const balanceAfter = await getDepositedBalance(asset);

  console.log(`[tools/capital] Withdrew ${amount} ${ticker} from Aave. Position: ${balanceBefore} → ${balanceAfter}`);
  return { action: 'withdraw', amount, txHash, balanceBefore, balanceAfter };
}

export async function withdrawFromAave(amountUsdt: string): Promise<AaveOperationResult> {
  return _withdrawFromAave(amountUsdt, 'usdt');
}

export async function withdrawUsdcFromAave(amountUsdc: string): Promise<AaveOperationResult> {
  return _withdrawFromAave(amountUsdc, 'usdc');
}

// ---------------------------------------------------------------------------
// Tool: get_bridge_fees
// ---------------------------------------------------------------------------

export { BridgeQuote };

/**
 * getBridgeFeesForAgent — Quote current deBridge fees for all active routes.
 *
 * Called by the agent as `get_bridge_fees`. Intended for board meetings so the
 * agent can factor bridging costs into capital allocation decisions — e.g.
 * "is it worth bridging $50 from Tron to Arbitrum given the current fee?".
 *
 * Uses a $100 reference amount by default. Fee percentages scale with amount
 * because the fixed operating expense portion shrinks relative to the transfer.
 */
export async function getBridgeFeesForAgent(referenceAmountUsdt = '100'): Promise<BridgeQuote[]> {
  return getBridgeFees(referenceAmountUsdt);
}
