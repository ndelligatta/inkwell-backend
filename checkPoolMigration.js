// Check if a DBC pool has migrated to DAMM and get the new pool address
const { Connection, PublicKey } = require('@solana/web3.js');
const { 
  DynamicBondingCurveClient,
  deriveDammV1PoolAddress,
  deriveDammV2PoolAddress,
  DAMM_V1_MIGRATION_FEE_ADDRESS,
  DAMM_V2_MIGRATION_FEE_ADDRESS
} = require('@meteora-ag/dynamic-bonding-curve-sdk');

const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

async function checkPoolMigration(poolAddress) {
  try {
    console.log('Checking migration status for pool:', poolAddress);
    
    // Initialize connection and client
    const connection = new Connection(RPC_URL, 'confirmed');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    const poolPubkey = new PublicKey(poolAddress);
    
    try {
      // First try to get the pool state to check if it's migrated
      const poolState = await dbcClient.state.getPool(poolPubkey);
      
      if (!poolState.isMigrated) {
        console.log('Pool has not migrated yet');
        return {
          migrated: false,
          originalPool: poolAddress,
          message: 'Pool is still in bonding curve phase'
        };
      }
      
      console.log('Pool has migrated! Getting migration details...');
      
      // Get the pool config to determine migration fee option
      let migrationFeeOption = 0;
      try {
        const poolConfigState = await dbcClient.state.getPoolConfig(poolState.config);
        migrationFeeOption = poolConfigState.migrationFeeOption || 0;
      } catch (configError) {
        console.log('Could not fetch pool config, using default migration fee option 0');
        migrationFeeOption = 0;
      }
      
      // Get token mints
      const baseMint = poolState.baseMint;
      const quoteMint = poolState.quoteMint;
      
      console.log('Base Mint:', baseMint ? baseMint.toString() : 'undefined');
      console.log('Quote Mint:', quoteMint ? quoteMint.toString() : 'undefined');
      console.log('Migration Fee Option:', migrationFeeOption);
      
      if (!baseMint || !quoteMint) {
        throw new Error('Missing base or quote mint');
      }
      
      // Derive both DAMM v1 and v2 addresses
      const dammV1Config = DAMM_V1_MIGRATION_FEE_ADDRESS[migrationFeeOption];
      const dammV2Config = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
      
      const dammV1PoolAddress = deriveDammV1PoolAddress(dammV1Config, baseMint, quoteMint);
      const dammV2PoolAddress = deriveDammV2PoolAddress(dammV2Config, baseMint, quoteMint);
      
      // Check which pool exists
      let newPoolAddress = null;
      let dammVersion = null;
      
      // Check DAMM v2 first (more common)
      try {
        const v2Account = await connection.getAccountInfo(dammV2PoolAddress);
        if (v2Account && v2Account.owner.toString() === 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG') {
          newPoolAddress = dammV2PoolAddress.toString();
          dammVersion = 'v2';
          console.log('Found DAMM v2 pool:', newPoolAddress);
        }
      } catch (e) {
        // Ignore error
      }
      
      // If no v2, check v1
      if (!newPoolAddress) {
        try {
          const v1Account = await connection.getAccountInfo(dammV1PoolAddress);
          if (v1Account && v1Account.owner.toString() === 'DMM2AJfNUngnCSZkfQ3F1VhqeF7uemUNnFQqUUxT3mLR') {
            newPoolAddress = dammV1PoolAddress.toString();
            dammVersion = 'v1';
            console.log('Found DAMM v1 pool:', newPoolAddress);
          }
        } catch (e) {
          // Ignore error
        }
      }
      
      if (newPoolAddress) {
        return {
          migrated: true,
          originalPool: poolAddress,
          newPoolAddress: newPoolAddress,
          dammVersion: dammVersion,
          message: `Pool has migrated to DAMM ${dammVersion}`,
          tokenMint: baseMint.toString()
        };
      } else {
        console.log('WARNING: Pool marked as migrated but no DAMM pool found');
        return {
          migrated: false,
          originalPool: poolAddress,
          message: 'Pool marked as migrated but DAMM pool not found',
          tokenMint: baseMint.toString()
        };
      }
      
    } catch (error) {
      console.log('Could not fetch pool state, trying alternative method...');
      
      // If we can't get pool state, try to get token mint from database
      const { createClient } = require('@supabase/supabase-js');
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      
      let tokenMint = null;
      let configAddress = null;
      
      if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false }
        });
        
        // Try to get pool info from database
        const { data } = await supabase
          .from('token_pools')
          .select('token_mint, config_address')
          .eq('pool_address', poolAddress)
          .single();
        
        if (data) {
          tokenMint = data.token_mint;
          configAddress = data.config_address;
          console.log('Found token mint from database:', tokenMint);
          console.log('Config address:', configAddress);
          
          if (tokenMint && configAddress) {
            // Try to derive the pool addresses
            const baseMint = new PublicKey(tokenMint);
            const quoteMint = new PublicKey("So11111111111111111111111111111111111111112"); // SOL
            const configPubkey = new PublicKey(configAddress);
            
            // Get config to determine migration fee option
            const poolConfigState = await dbcClient.state.getPoolConfig(configPubkey);
            const migrationFeeOption = poolConfigState.migrationFeeOption || 0;
            
            // Derive addresses
            const dammV1Config = DAMM_V1_MIGRATION_FEE_ADDRESS[migrationFeeOption];
            const dammV2Config = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
            
            const dammV1PoolAddress = deriveDammV1PoolAddress(dammV1Config, baseMint, quoteMint);
            const dammV2PoolAddress = deriveDammV2PoolAddress(dammV2Config, baseMint, quoteMint);
            
            // Check which exists
            let newPoolAddress = null;
            let dammVersion = null;
            
            // Check DAMM v2 first
            try {
              const v2Account = await connection.getAccountInfo(dammV2PoolAddress);
              if (v2Account && v2Account.owner.toString() === 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG') {
                newPoolAddress = dammV2PoolAddress.toString();
                dammVersion = 'v2';
                console.log('Found DAMM v2 pool:', newPoolAddress);
              }
            } catch (e) {
              // Ignore
            }
            
            // If no v2, check v1
            if (!newPoolAddress) {
              try {
                const v1Account = await connection.getAccountInfo(dammV1PoolAddress);
                if (v1Account && v1Account.owner.toString() === 'DMM2AJfNUngnCSZkfQ3F1VhqeF7uemUNnFQqUUxT3mLR') {
                  newPoolAddress = dammV1PoolAddress.toString();
                  dammVersion = 'v1';
                  console.log('Found DAMM v1 pool:', newPoolAddress);
                }
              } catch (e) {
                // Ignore
              }
            }
            
            if (newPoolAddress) {
              return {
                migrated: true,
                originalPool: poolAddress,
                newPoolAddress: newPoolAddress,
                dammVersion: dammVersion,
                message: `Pool has migrated to DAMM ${dammVersion}`,
                tokenMint: tokenMint
              };
            }
          }
        }
      }
      
      // If all else fails, return not migrated
      console.log('Could not determine migration status');
      return {
        migrated: false,
        originalPool: poolAddress,
        message: 'Could not determine migration status'
      };
    }
    
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