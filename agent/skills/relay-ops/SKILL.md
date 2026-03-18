---
name: relay-ops
description: Access payment relay metrics, experiment log, capital state, and operational controls for the TRON USDT relay business.
metadata:
  openclaw:
    requires:
      env:
        - SQLITE_PATH
---

# relay-ops Skill

This skill provides the agent with tools to read the relay's operational state and take business actions. All tools interact with the relay's SQLite database and wallet modules.

## Environment Requirements

- `SQLITE_PATH` — path to the SQLite database file. All metric and experiment queries read from this DB.

## Available Tools

### Metrics & Analytics

---

#### `get_metrics`

Return rolling financial and operational metrics.

**Parameters:**
- `days` (number, required) — rolling window in days. Common values: 1, 7, 30.

**Returns:**
```json
{
  "period": "Last 7 days",
  "totalRevenueUsdt": 12.40,
  "totalRevenueUsdc": 0.84,
  "totalTransactions": 124,
  "avgDailyTransactions": 17.7,
  "avgConfirmationSeconds": 11,
  "llmCalls": 8,
  "llmCostUsd": 1.24,
  "aaveYieldUsdt": 0.09,
  "netRevenueUsd": 12.09
}
```

**When to use:** At the start of every board meeting, and before making pricing or capital allocation decisions.

---

#### `get_runway`

Calculate operational runway: how many days can the relay operate at current cost rates?

**Parameters:** None.

**Returns:**
```json
{
  "runwayDays": 847,
  "totalLiquidUsd": 234.50,
  "aavePositionUsd": 180.00,
  "trxReserveTrx": 120.5,
  "dailyRevenueUsd": 1.77,
  "dailyExpensesUsd": 0.90,
  "netDailyCostUsd": -0.87,
  "isProfit": true,
  "aaveApy": "4.50"
}
```

**Note:** `isProfit: true` means daily revenue exceeds daily expenses; `runwayDays` will be the string `"infinite"` in this case.

**When to use:** During board meetings when assessing financial health.

---

### Experiment Management

---

#### `get_experiments`

Return the experiment log.

**Parameters:**
- `status` (string, optional) — filter by `"pending"` or `"evaluated"`. Omit for all.
- `limit` (number, optional) — maximum number to return (default: 20, most recent first).

**Returns:** Array of experiment objects with fields: `id`, `created_at`, `context`, `hypothesis`, `decision`, `metric`, `check_date`, `outcome`, `learning`, `status`.

**When to use:** At the start of every board meeting to review pending experiments and recent learnings.

---

#### `save_experiment`

Create a new experiment record. **Always call this BEFORE taking the action described in `decision`.**

**Parameters:**
- `context` (string) — what situation prompted this experiment.
- `hypothesis` (string) — specific, measurable prediction.
- `decision` (string) — what action will be taken.
- `metric` (string) — what to measure to evaluate the outcome.
- `checkDate` (string) — ISO date (YYYY-MM-DD) when to evaluate. Must be in the future.

**Returns:** The created experiment object including its generated `id`.

**When to use:** Before fee changes, before Aave rebalancing >10%, before any new operational approach.

---

#### `evaluate_experiment`

Record the outcome and learning from a completed experiment.

**Parameters:**
- `id` (string) — the experiment UUID from `get_experiments`.
- `outcome` (string) — what actually happened (be specific and measurable).
- `learning` (string) — what this implies for future decisions.

**Returns:** void.

**When to use:** When `get_experiments` returns experiments with `check_date` in the past and `status = "pending"`.

---

### Pricing

---

#### `update_fee`

Change the relay fee percentage. Takes effect immediately for new payment requests.

**Parameters:**
- `newPercent` (number) — new fee as a percentage (e.g., `0.25` for 0.25%).
- `reason` (string) — human-readable reason, including experiment ID if applicable.

**Constraints:**
- Fee must be between 0.1% and 2.0%.
- Maximum single-step change: 0.5% (0.2% recommended without strong evidence).

**Returns:** `{ previousFeePercent, newFeePercent, reason, changedAt }`

**When to use:** Only after calling `save_experiment` first.

---

### Capital Allocation

---

#### `get_capital_summary`

Return a snapshot of all capital positions.

**Parameters:** None.

**Returns:**
```json
{
  "liquidUsdtArbitrum": "54.32",
  "liquidUsdcBase": "8.41",
  "aaveUsdtDeposited": "180.00",
  "trxReserve": "120.500000",
  "aaveApyPercent": "4.50",
  "totalUsdEquivalent": "242.73"
}
```

**When to use:** At the start of any capital allocation decision.

---

#### `deposit_to_aave`

Deposit USDT from the liquid balance into Aave on Arbitrum.

**Parameters:**
- `amountUsdt` (string) — decimal string, e.g. `"50.00"`.

**Constraints:**
- Cannot exceed current liquid USDT balance.
- Minimum deposit: 1 USDT.
- After deposit, liquid balance must still cover the minimum float requirement.

**Returns:** `{ action, amount, txHash, balanceBefore, balanceAfter }`

**When to use:** When `get_capital_summary` shows excess liquid USDT above the minimum float. Always call `save_experiment` first if the deposit amount is >10% of the current Aave position.

---

#### `withdraw_from_aave`

Withdraw USDT from Aave back to liquid balance.

**Parameters:**
- `amountUsdt` (string) — decimal string, or `"MAX"` for full withdrawal.

**Returns:** `{ action, amount, txHash, balanceBefore, balanceAfter }`

**When to use:** Only when liquid USDT has dropped below the minimum float (operational need), never for speculative reasons.
