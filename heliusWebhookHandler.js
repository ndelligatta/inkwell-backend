// Helius webhook handler for real-time fee tracking
const { PublicKey } = require('@solana/web3.js');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// Initialize Supabase client for database operations
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
) : null;

// Meteora DBC Program ID
const METEORA_DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

// Setup webhook for a specific pool
async function setupPoolWebhook(poolAddress, postId) {
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "726140d8-6b0d-4719-8702-682d81e94a37";
  
  console.log(`Setting up webhook for pool: ${poolAddress}`);
  
  const webhookConfig = {
    webhookURL: `${process.env.BACKEND_URL || 'https://blockparty-backend-production.up.railway.app'}/api/webhooks/helius/pool-events`,
    transactionTypes: ["ANY"], // Monitor all transactions
    accountAddresses: [poolAddress], // Monitor specific pool
    webhookType: "enhanced", // Get parsed data
    authHeader: process.env.WEBHOOK_AUTH_TOKEN || 'inkwell-webhook-secret'
  };

  try {
    const response = await axios.post(
      `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`,
      webhookConfig
    );
    
    console.log('Webhook created successfully:', response.data);
    
    // Store webhook info in database
    if (supabase) {
      await supabase
        .from('pool_webhooks')
        .insert({
          pool_address: poolAddress,
          post_id: postId,
          webhook_id: response.data.webhookID,
          status: 'active'
        });
    }
      
    return response.data;
  } catch (error) {
    console.error('Error creating webhook:', error.response?.data || error);
    throw error;
  }
}

// Process webhook events
async function processWebhookEvent(webhookData) {
  console.log('====== PROCESSING WEBHOOK EVENT ======');
  
  try {
    // Enhanced webhooks provide an array of transactions
    const transactions = Array.isArray(webhookData) ? webhookData : [webhookData];
    
    for (const tx of transactions) {
      // Check if this is a swap transaction on DBC
      if (isDBCSwapTransaction(tx)) {
        await processSwapEvent(tx);
      }
    }
    
    return { success: true, processed: transactions.length };
  } catch (error) {
    console.error('Error processing webhook:', error);
    return { success: false, error: error.message };
  }
}

// Check if transaction is a DBC swap
function isDBCSwapTransaction(transaction) {
  try {
    // Check if any instruction is from DBC program
    const instructions = transaction.instructions || [];
    
    for (const ix of instructions) {
      if (ix.programId === METEORA_DBC_PROGRAM) {
        // Look for swap-related logs or instruction data
        const logs = transaction.logs || [];
        const hasSwapLog = logs.some(log => 
          log.toLowerCase().includes('swap') ||
          log.includes('Program log: Instruction: Buy') ||
          log.includes('Program log: Instruction: Sell')
        );
        
        if (hasSwapLog) {
          console.log('Found DBC swap transaction:', transaction.signature);
          return true;
        }
      }
    }
    
    return false;
  } catch (error) {
    console.error('Error checking transaction type:', error);
    return false;
  }
}

// Process a swap event
async function processSwapEvent(transaction) {
  console.log('Processing swap event:', transaction.signature);
  
  try {
    // Extract pool address from accounts
    const poolAddress = extractPoolAddress(transaction);
    if (!poolAddress) {
      console.error('Could not extract pool address from transaction');
      return;
    }
    
    // Calculate fee from swap (4% of swap amount)
    const feeAmount = calculateSwapFee(transaction);
    
    console.log(`Pool: ${poolAddress}, Fee: ${feeAmount} SOL`);
    
    // Update database
    if (supabase) {
      // Call the SQL function to update fees atomically
      const { data, error } = await supabase.rpc('update_pool_fees', {
        p_pool_address: poolAddress,
        p_fee_amount_sol: feeAmount,
        p_transaction_signature: transaction.signature
      });
      
      if (error) {
        console.error('Database update error:', error);
      } else {
        console.log('Database updated successfully');
      }
      
      // Also update the total directly (backup method)
      await supabase
        .from('user_posts')
        .update({
          total_fees_generated_all_time: supabase.raw('total_fees_generated_all_time + ?', [feeAmount]),
          last_fee_update_at: new Date().toISOString()
        })
        .eq('pool_address', poolAddress);
    }
    
    return { poolAddress, feeAmount, signature: transaction.signature };
  } catch (error) {
    console.error('Error processing swap:', error);
    throw error;
  }
}

// Extract pool address from transaction
function extractPoolAddress(transaction) {
  try {
    // In DBC transactions, the pool is usually one of the account keys
    const accountKeys = transaction.accountData || [];
    
    // Look for the pool account (usually has specific characteristics)
    for (const account of accountKeys) {
      // Check if this could be a pool address
      if (account.account && isValidPoolAddress(account.account)) {
        return account.account;
      }
    }
    
    // Fallback: check instruction accounts
    const instructions = transaction.instructions || [];
    for (const ix of instructions) {
      if (ix.programId === METEORA_DBC_PROGRAM && ix.accounts?.length > 0) {
        // Pool is typically the first account in swap instructions
        return ix.accounts[0];
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting pool address:', error);
    return null;
  }
}

// Validate if address could be a pool
function isValidPoolAddress(address) {
  try {
    new PublicKey(address);
    return address.length === 44; // Valid Solana address length
  } catch {
    return false;
  }
}

// Calculate swap fee from transaction
function calculateSwapFee(transaction) {
  try {
    // Look for token balance changes to calculate swap amount
    const tokenBalanceChanges = transaction.tokenBalanceChanges || [];
    
    let swapAmountSOL = 0;
    
    // Find SOL transfer amount
    for (const change of tokenBalanceChanges) {
      if (change.mint === 'So11111111111111111111111111111111111111112') {
        // This is SOL
        const amount = Math.abs(change.rawTokenAmount?.tokenAmount || 0) / 1e9;
        if (amount > swapAmountSOL) {
          swapAmountSOL = amount;
        }
      }
    }
    
    // If no token balance changes, check native balance changes
    if (swapAmountSOL === 0) {
      const nativeBalanceChanges = transaction.nativeBalanceChanges || [];
      for (const change of nativeBalanceChanges) {
        const amount = Math.abs(change.amount || 0) / 1e9;
        if (amount > swapAmountSOL) {
          swapAmountSOL = amount;
        }
      }
    }
    
    // Calculate 4% fee
    const feeAmount = swapAmountSOL * 0.04;
    
    console.log(`Swap amount: ${swapAmountSOL} SOL, Fee: ${feeAmount} SOL`);
    
    return feeAmount;
  } catch (error) {
    console.error('Error calculating fee:', error);
    return 0;
  }
}

// List all active webhooks
async function listWebhooks() {
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "726140d8-6b0d-4719-8702-682d81e94a37";
  
  try {
    const response = await axios.get(
      `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`
    );
    
    console.log('Active webhooks:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error listing webhooks:', error);
    return [];
  }
}

// Delete webhook
async function deleteWebhook(webhookId) {
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "726140d8-6b0d-4719-8702-682d81e94a37";
  
  try {
    await axios.delete(
      `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${HELIUS_API_KEY}`
    );
    
    console.log('Webhook deleted:', webhookId);
    return true;
  } catch (error) {
    console.error('Error deleting webhook:', error);
    return false;
  }
}

module.exports = {
  setupPoolWebhook,
  processWebhookEvent,
  listWebhooks,
  deleteWebhook
};