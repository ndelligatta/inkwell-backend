// Check if a DBC pool has migrated to DAMM and get the new pool address
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

async function checkPoolMigration(poolAddress) {
  try {
    console.log('Checking migration status for pool:', poolAddress);
    
    // Since the SDK method isn't working, let's use a different approach
    // We'll use the Meteora API or check for the pool on different DEXs
    
    // First, let's try to get the token mint from our database
    const { createClient } = require('@supabase/supabase-js');
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    let tokenMint = null;
    
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      
      // First try user_posts table
      let { data } = await supabase
        .from('user_posts')
        .select('token_mint')
        .eq('pool_address', poolAddress)
        .single();
      
      // If not found in user_posts, try token_pools table
      if (!data || !data.token_mint) {
        const poolResult = await supabase
          .from('token_pools')
          .select('token_mint')
          .eq('pool_address', poolAddress)
          .single();
        
        if (poolResult.data) {
          data = poolResult.data;
        }
      }
      
      if (data && data.token_mint) {
        tokenMint = data.token_mint;
        console.log('Found token mint from database:', tokenMint);
      }
    }
    
    if (!tokenMint) {
      console.log('Could not find token mint for pool');
      return {
        migrated: false,
        originalPool: poolAddress,
        message: 'Could not determine migration status - token mint not found'
      };
    }
    
    // Use Jupiter API to find pools for this token
    try {
      console.log('Checking Jupiter for token markets...');
      const response = await axios.get(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenMint}&amount=1000000`, {
        timeout: 5000
      });
      
      if (response.data) {
        // Look for Meteora DAMM in the route
        const routePlan = response.data.routePlan || response.data.data;
        
        if (routePlan && Array.isArray(routePlan)) {
          for (const route of routePlan) {
            const swapInfo = route.swapInfo || route.marketInfos?.[0];
            if (swapInfo && swapInfo.label && swapInfo.label.includes('Meteora DAMM')) {
              const ammKey = swapInfo.ammKey || swapInfo.id;
              console.log('Found DAMM pool:', ammKey);
              
              // Determine DAMM version from label
              const dammVersion = swapInfo.label.includes('v2') ? 'v2' : 'v1';
              
              return {
                migrated: true,
                originalPool: poolAddress,
                newPoolAddress: ammKey,
                dammVersion: dammVersion,
                message: `Pool has migrated to DAMM ${dammVersion}`,
                tokenMint: tokenMint
              };
            }
          }
        }
      }
    } catch (jupiterError) {
      console.log('Jupiter API error:', jupiterError.message);
    }
    
    // Alternative: Check DexScreener
    try {
      console.log('Checking DexScreener for token markets...');
      const dexResponse = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
        timeout: 5000
      });
      
      if (dexResponse.data && dexResponse.data.pairs) {
        for (const pair of dexResponse.data.pairs) {
          if (pair.dexId === 'meteora' && pair.pairAddress !== poolAddress) {
            console.log('Found Meteora DAMM pool on DexScreener:', pair.pairAddress);
            return {
              migrated: true,
              originalPool: poolAddress,
              newPoolAddress: pair.pairAddress,
              dammVersion: 'v2', // DexScreener usually shows DAMM v2 pools
              message: 'Pool has migrated to DAMM (found via DexScreener)',
              tokenMint: tokenMint
            };
          }
        }
      }
    } catch (dexError) {
      console.log('DexScreener API error:', dexError.message);
    }
    
    // If we couldn't find a DAMM pool, assume it hasn't migrated
    console.log('No DAMM pool found - pool may not have migrated yet');
    return {
      migrated: false,
      originalPool: poolAddress,
      message: 'Pool appears to still be in bonding curve phase',
      tokenMint: tokenMint
    };
    
  } catch (error) {
    console.error('Error checking pool migration:', error);
    return {
      migrated: false,
      error: error.message,
      originalPool: poolAddress,
      message: 'Failed to check migration status'
    };
  }
}

module.exports = { checkPoolMigration };