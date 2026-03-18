---
name: wdk-wallet
description: Interact with WDK-managed wallets — check balances, send USDT, manage Aave positions, query TRON energy costs
version: 1.0.0
metadata:
  openclaw:
    requires:
      env:
        - WDK_SEED_PHRASE
        - TRON_API_KEY
        - ARBITRUM_RPC_URL
        - BASE_RPC_URL
    emoji: "💼"
    homepage: https://docs.wallet.tether.io
---

# WDK Wallet

This skill provides access to the agent's self-custodial wallets across TRON, Base, and Arbitrum via Tether's Wallet Development Kit (WDK). All signing happens locally — the seed phrase never leaves the machine.

## Available Tools

### Balance queries

**check_tron_balance(address?)**
Returns the USDT TRC-20 balance of the agent's TRON wallet (or a specific address).
- `address` — optional; defaults to the agent's primary TRON address

**check_evm_balance(chain, token)**
Returns token balance on an EVM chain.
- `chain` — `"base"` | `"arbitrum"`
- `token` — `"USDC"` | `"USDT"` | `"ETH"`

**get_aave_position()**
Returns the agent's current Aave USDT deposit balance and accrued yield on Arbitrum.

**get_trx_balance()**
Returns the agent's TRX balance (used for energy sponsorship reserve).

### Capital operations

**deposit_aave(amount_usdt)**
Deposit USDT into the Aave lending pool on Arbitrum.
- `amount_usdt` — decimal string, e.g. `"100.00"`
- Returns the Aave deposit transaction hash.

**withdraw_aave(amount_usdt)**
Withdraw USDT from the Aave lending pool.
- `amount_usdt` — decimal string, or `"MAX"` to withdraw the full position.
- Returns the withdrawal transaction hash.

**swap_usdc_to_usdt(amount_usdc)**
Swap USDC on Base to USDT on Arbitrum via the Velora DEX aggregator.
- `amount_usdc` — decimal string
- Returns estimated USDT received and the swap transaction hash.

### Information

**get_aave_apy()**
Returns the current Aave USDT variable supply APY as a percentage.
Useful for the capital allocation decision: if APY < 2%, Aave deployment may not cover gas overhead.

**get_wallet_addresses()**
Returns the agent's primary addresses on each supported chain:
- TRON (HD index 0)
- Base
- Arbitrum

## Usage notes

- All monetary amounts are decimal strings (e.g. `"50.00"`), never raw numbers, to avoid floating-point precision issues.
- `deposit_aave` and `withdraw_aave` require USDT on Arbitrum. If the agent's USDT is on TRON, it must be bridged first (not yet supported — describe the limitation in responses rather than attempting it).
- Energy sponsorship (covering TRX for gasless TRON transfers) is handled automatically by the relay's service layer; this skill does not need to manage it directly.
- Never request the seed phrase or private keys — they are managed internally by WDK and are not exposed through these tools.
