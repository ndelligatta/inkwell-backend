// Get lifetime fees for DBC pools using SDK
const { Connection, PublicKey } = require('@solana/web3.js');
const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { createClient } = require('@supabase/supabase-js');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Initialize Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

console.log('🔧 Supabase initialization:');
console.log(`- URL: ${SUPABASE_URL ? 'Found' : '❌ MISSING'}`);
console.log(`- Anon Key: ${SUPABASE_ANON_KEY ? 'Found' : '❌ MISSING'}`);

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

if (!supabase) {
  console.error('❌ SUPABASE CLIENT NOT INITIALIZED! Check environment variables.');
}

// Get lifetime fees for a pool
async function getLifetimeFees(poolAddress) {
  try {
    const connection = new Connection(RPC_URL, 'confirmed');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    const poolPubkey = new PublicKey(poolAddress);
    
    console.log(`Fetching fee metrics for pool ${poolAddress}...`);
    
    // Get current unclaimed fees from SDK
    const feeMetrics = await dbcClient.state.getPoolFeeMetrics(poolPubkey);
    
    let currentUnclaimedFees = 0;
    if (feeMetrics && feeMetrics.current) {
      const creatorFees = feeMetrics.current.creatorBaseFee.toNumber() / 1e9 + 
                         feeMetrics.current.creatorQuoteFee.toNumber() / 1e9;
      const platformFees = feeMetrics.current.partnerBaseFee.toNumber() / 1e9 + 
                          feeMetrics.current.partnerQuoteFee.toNumber() / 1e9;
      currentUnclaimedFees = creatorFees + platformFees;
    }
    
    // Get total claimed fees from database
    let totalClaimedFees = 0;
    if (supabase) {
      const { data, error } = await supabase
        .from('user_posts')
        .select('total_fees_claimed')
        .eq('pool_address', poolAddress)
        .single();
        
      if (data && data.total_fees_claimed) {
        totalClaimedFees = parseFloat(data.total_fees_claimed);
      }
    }
    
    // Lifetime fees = current unclaimed + total claimed
    const lifetimeFees = currentUnclaimedFees + totalClaimedFees;
    
    console.log(`Lifetime fees for ${poolAddress}:`);
    console.log(`- Current unclaimed: ${currentUnclaimedFees} SOL`);
    console.log(`- Total claimed: ${totalClaimedFees} SOL`);
    console.log(`- LIFETIME TOTAL: ${lifetimeFees} SOL`);
    
    return {
      success: true,
      lifetimeFees,
      currentUnclaimedFees,
      totalClaimedFees
    };
    
  } catch (error) {
    console.error(`Error fetching lifetime fees for ${poolAddress}:`, error);
    return {
      success: false,
      error: error.message,
      lifetimeFees: 0
    };
  }
}

// Update all pools with lifetime fees
async function updateAllPoolsLifetimeFees() {
  if (!supabase) {
    console.error('Supabase not initialized');
    return;
  }
  
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
    
    console.log(`Updating lifetime fees for ${posts.length} pools...`);
    
    for (const post of posts) {
      const result = await getLifetimeFees(post.pool_address);
      
      if (result.success) {
        // Update database with lifetime fees
        console.log(`\n📝 UPDATING DATABASE for pool ${post.pool_address}:`);
        console.log(`- Post ID: ${post.id}`);
        console.log(`- Lifetime fees to insert: ${result.lifetimeFees} SOL`);
        
        const { data, error } = await supabase
          .from('user_posts')
          .update({
            total_fees_generated_all_time: result.lifetimeFees,
            last_fee_update_at: new Date().toISOString()
          })
          .eq('id', post.id)
          .select();
          
        if (error) {
          console.error(`❌ DATABASE UPDATE FAILED for ${post.pool_address}:`, error);
          console.error(`Error details:`, JSON.stringify(error, null, 2));
        } else {
          console.log(`✅ DATABASE UPDATE SUCCESS for ${post.pool_address}`);
          console.log(`Returned data:`, data);
          if (data && data.length > 0) {
            console.log(`Verified DB value: ${data[0].total_fees_generated_all_time} SOL`);
          }
        }
      }
      
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log('Finished updating all pools');
  } catch (error) {
    console.error('Error updating all pools:', error);
  }
}

module.exports = {
  getLifetimeFees,
  updateAllPoolsLifetimeFees
};