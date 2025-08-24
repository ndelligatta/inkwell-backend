# Fee Tracking Implementation Plan

## Problem Analysis
1. **Helius webhooks only send individual transaction data**, not cumulative totals
2. **Current webhook handler isn't properly extracting pool addresses** from the enhanced webhook data
3. **Need to track both real-time updates AND sync all-time totals**

## Solution: Dual Approach

### 1. Real-Time Tracking (Helius Webhooks)
- Track each swap transaction as it happens
- Extract swap amounts and calculate 4% fee
- Add to running total in database

### 2. Periodic Sync (Meteora API)
- Use Meteora's pool metrics API to get accurate all-time totals
- Run sync job every 5 minutes
- Ensures accuracy even if webhooks miss transactions

## Implementation Steps

### Step 1: Fix Webhook Data Extraction
The enhanced webhook data structure includes:
- `events.swap` - Contains swap details
- `tokenBalanceChanges` - Token transfers
- `nativeBalanceChanges` - SOL transfers
- `accountData` - Accounts involved

### Step 2: Add Meteora API Integration
```javascript
// Get all-time fees from Meteora
const response = await axios.get(
  `https://api.meteora.ag/pools/${poolAddress}/metrics`
);
```

### Step 3: Database Updates
- Real-time: Add individual swap fees to total
- Periodic: Sync with Meteora's all-time total
- Track last sync time to avoid duplicates

### Step 4: Add Background Job
Create a cron job that:
1. Fetches all pools from database
2. Gets latest fee metrics from Meteora
3. Updates database with accurate totals
4. Runs every 5 minutes

## Benefits
- **Real-time updates** from webhooks (instant UI updates)
- **Accurate totals** from Meteora API (source of truth)
- **No missed transactions** (periodic sync catches everything)
- **Handles edge cases** (webhook failures, missed events)

## Next Steps
1. Replace current webhook handler with V2
2. Add sync endpoint to server.js
3. Set up periodic sync job
4. Test with real pool data