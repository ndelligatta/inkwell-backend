// Improved Helius webhook handler with proper fee tracking
const { PublicKey } = require('@solana/web3.js');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// Initialize Supabase client
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
    transactionTypes: ["ANY"],
    accountAddresses: [poolAddress],
    webhookType: "enhanced",
    authHeader: process.env.WEBHOOK_AUTH_TOKEN || 'inkwell-webhook-secret'
  };

  try {
    const response = await axios.post(
      `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`,
      webhookConfig
    );
    
    console.log('Webhook created successfully:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error creating webhook:', error.response?.data || error);
    throw error;
  }
}

// Process webhook events - IMPROVED VERSION
async function processWebhookEvent(webhookData) {
  console.log('====== PROCESSING WEBHOOK EVENT ======');
  console.log('Raw webhook data structure:', JSON.stringify(webhookData, null, 2).substring(0, 500));
  
  try {
    // Enhanced webhooks provide an array of transactions
    const transactions = Array.isArray(webhookData) ? webhookData : [webhookData];
    
    for (const tx of transactions) {
      // Process each transaction
      await processTransaction(tx);
    }
    
    return { success: true, processed: transactions.length };
  } catch (error) {
    console.error('Error processing webhook:', error);
    return { success: false, error: error.message };
  }
}

// Process individual transaction
async function processTransaction(txData) {
  console.log('\n=== Processing Transaction ===');
  console.log('Signature:', txData.signature);
  console.log('Type:', txData.type);
  
  try {
    // Extract pool address from accountData
    let poolAddress = null;
    
    // Method 1: Check accountData for pool address
    if (txData.accountData && Array.isArray(txData.accountData)) {
      for (const account of txData.accountData) {
        // The pool address should match one we're monitoring
        if (account.account) {
          console.log('Checking account:', account.account);
          poolAddress = account.account;
          break;
        }
      }
    }
    
    // Method 2: Check description for swap details
    if (!poolAddress && txData.description) {
      console.log('Transaction description:', txData.description);
      // Parse pool from description if available
    }
    
    // Method 3: Check events for swap data
    if (txData.events && txData.events.swap) {
      console.log('Swap event found:', txData.events.swap);
      const swapData = txData.events.swap;
      
      // Calculate fee based on swap amount
      let swapAmountSOL = 0;
      
      // Get token amounts from swap data
      if (swapData.tokenInputs && swapData.tokenInputs.length > 0) {
        for (const input of swapData.tokenInputs) {
          if (input.mint === 'So11111111111111111111111111111111111111112') {
            swapAmountSOL = parseFloat(input.tokenAmount) / 1e9;
            break;
          }
        }
      }
      
      if (swapData.tokenOutputs && swapData.tokenOutputs.length > 0) {
        for (const output of swapData.tokenOutputs) {
          if (output.mint === 'So11111111111111111111111111111111111111112') {
            const outputSOL = parseFloat(output.tokenAmount) / 1e9;
            if (outputSOL > swapAmountSOL) {
              swapAmountSOL = outputSOL;
            }
          }
        }
      }
      
      // Calculate 4% fee
      const feeAmount = swapAmountSOL * 0.04;
      
      console.log(`Swap amount: ${swapAmountSOL} SOL`);
      console.log(`Fee amount: ${feeAmount} SOL`);
      
      // Update database if we have a valid pool and fee
      if (poolAddress && feeAmount > 0) {
        await updatePoolFees(poolAddress, feeAmount, txData.signature);
      }
    }
    
    // Method 4: Check native/token balance changes
    if (!poolAddress || !txData.events?.swap) {
      // Extract from balance changes
      const { poolAddr, feeAmt } = extractFromBalanceChanges(txData);
      if (poolAddr && feeAmt > 0) {
        poolAddress = poolAddr;
        await updatePoolFees(poolAddress, feeAmt, txData.signature);
      }
    }
    
  } catch (error) {
    console.error('Error processing transaction:', error);
  }
}

// Extract pool and fee from balance changes
function extractFromBalanceChanges(txData) {
  let poolAddr = null;
  let feeAmt = 0;
  
  try {
    // Check token balance changes
    if (txData.tokenBalanceChanges && Array.isArray(txData.tokenBalanceChanges)) {
      for (const change of txData.tokenBalanceChanges) {
        if (change.mint === 'So11111111111111111111111111111111111111112') {
          // SOL changes
          const amount = Math.abs(parseFloat(change.rawTokenAmount?.tokenAmount || 0)) / 1e9;
          if (amount > 0) {
            feeAmt = amount * 0.04; // 4% fee
          }
        }
        
        // The account with balance change might be the pool
        if (change.userAccount && !poolAddr) {
          poolAddr = change.userAccount;
        }
      }
    }
    
    // Check native balance changes
    if (txData.nativeBalanceChanges && Array.isArray(txData.nativeBalanceChanges)) {
      for (const change of txData.nativeBalanceChanges) {
        const amount = Math.abs(change.amount || 0) / 1e9;
        if (amount > 0 && amount > feeAmt) {
          feeAmt = amount * 0.04; // 4% fee
        }
        
        // The account might be the pool
        if (change.account && !poolAddr) {
          poolAddr = change.account;
        }
      }
    }
    
  } catch (error) {
    console.error('Error extracting from balance changes:', error);
  }
  
  return { poolAddr, feeAmt };
}

// Update pool fees in database
async function updatePoolFees(poolAddress, feeAmount, signature) {
  if (!supabase || !poolAddress || feeAmount <= 0) {
    console.error('Invalid parameters for fee update:', { poolAddress, feeAmount });
    return;
  }
  
  console.log(`\nUpdating fees for pool ${poolAddress}: +${feeAmount} SOL`);
  
  try {
    // Get current total
    const { data: currentPost, error: fetchError } = await supabase
      .from('user_posts')
      .select('total_fees_generated_all_time, total_fees_claimed')
      .eq('pool_address', poolAddress)
      .single();
      
    if (fetchError) {
      console.error('Error fetching current fees:', fetchError);
      return;
    }
    
    const currentTotal = parseFloat(currentPost?.total_fees_generated_all_time || '0');
    const newTotal = currentTotal + feeAmount;
    
    console.log(`Current total: ${currentTotal} SOL`);
    console.log(`New total: ${newTotal} SOL`);
    
    // Update with new total
    const { error: updateError } = await supabase
      .from('user_posts')
      .update({
        total_fees_generated_all_time: newTotal,
        last_fee_update_at: new Date().toISOString()
      })
      .eq('pool_address', poolAddress);
      
    if (updateError) {
      console.error('Database update error:', updateError);
    } else {
      console.log(`✅ Database updated successfully!`);
      console.log(`Pool ${poolAddress} total fees: ${newTotal} SOL`);
    }
  } catch (error) {
    console.error('Error updating pool fees:', error);
  }
}

// Get all-time fees from Meteora API
async function getAllTimeFees(poolAddress) {
  try {
    // Try multiple endpoints to get pool data with accumulated fees
    const endpoints = [
      `https://damm-api.meteora.ag/pools/${poolAddress}`,
      `https://dammv2-api.meteora.ag/pools/${poolAddress}`,
      // Fallback to the old endpoint that returns current fees
      `https://meteora-ozkfrax2c-meteora-ag.vercel.app/pool/${poolAddress}/fee-metrics`
    ];
    
    for (const endpoint of endpoints) {
      try {
        console.log(`Trying endpoint: ${endpoint}`);
        const response = await axios.get(endpoint);
        
        if (response.data) {
          // Check for accumulated_fee_volume (lifetime total)
          if (response.data.accumulated_fee_volume !== undefined) {
            const lifetimeFees = parseFloat(response.data.accumulated_fee_volume);
            console.log(`✅ LIFETIME FEES for ${poolAddress}: ${lifetimeFees} SOL`);
            console.log(`- From accumulated_fee_volume field`);
            return lifetimeFees;
          }
          
          // Fallback to current fees if no accumulated data
          if (response.data.current) {
            const metrics = response.data;
            const creatorFees = (parseFloat(metrics.current?.creatorBaseFee || 0) + parseFloat(metrics.current?.creatorQuoteFee || 0)) / 1e9;
            const platformFees = (parseFloat(metrics.current?.platformBaseFee || 0) + parseFloat(metrics.current?.platformQuoteFee || 0)) / 1e9;
            const totalFees = creatorFees + platformFees;
            
            console.log(`Current fees for ${poolAddress}: ${totalFees} SOL`);
            console.log(`(Note: This is current unclaimed, not lifetime total)`);
            
            return totalFees;
          }
        }
      } catch (err) {
        console.log(`Failed to fetch from ${endpoint}: ${err.message}`);
        continue;
      }
    }
    
  } catch (error) {
    console.error(`Error fetching all-time fees for ${poolAddress}:`, error.message);
  }
  
  return 0;
}

// Sync all-time fees periodically
async function syncAllTimeFees() {
  if (!supabase) return;
  
  try {
    // Get all pools
    const { data: posts, error } = await supabase
      .from('user_posts')
      .select('id, pool_address')
      .not('pool_address', 'is', null);
      
    if (error || !posts) {
      console.error('Error fetching pools:', error);
      return;
    }
    
    console.log(`Syncing fees for ${posts.length} pools...`);
    
    for (const post of posts) {
      const allTimeFees = await getAllTimeFees(post.pool_address);
      
      if (allTimeFees > 0) {
        await supabase
          .from('user_posts')
          .update({
            total_fees_generated_all_time: allTimeFees,
            last_fee_update_at: new Date().toISOString()
          })
          .eq('id', post.id);
          
        console.log(`Updated ${post.pool_address}: ${allTimeFees} SOL`);
      }
    }
  } catch (error) {
    console.error('Error syncing all-time fees:', error);
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
  deleteWebhook,
  syncAllTimeFees,
  getAllTimeFees
};