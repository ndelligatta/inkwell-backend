// Check if a DBC pool has migrated to DAMM and get the new pool address
const { Connection, PublicKey } = require('@solana/web3.js');
const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');

async function checkPoolMigration(poolAddress) {
  try {
    console.log('Checking migration status for pool:', poolAddress);
    
    // Initialize connection
    const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(RPC_URL, 'confirmed');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    
    // Get virtual pool state
    const poolPubkey = new PublicKey(poolAddress);
    const virtualPool = await dbcClient.state.getVirtualPool(poolPubkey);
    
    console.log('Virtual pool state fetched');
    console.log('Pool config:', virtualPool.config?.toString());
    
    // Check if pool has migrated
    // The virtualPool will have migration data if it has migrated
    if (virtualPool.migrated === true || virtualPool.migrationData) {
      console.log('Pool has migrated!');
      
      // Get the new DAMM pool address
      const newPoolAddress = virtualPool.migrationData?.ammPool || 
                            virtualPool.dammPool || 
                            virtualPool.migratedPool;
      
      // Get the config to determine DAMM version
      const poolConfig = await dbcClient.state.getPoolConfig(virtualPool.config);
      
      return {
        migrated: true,
        originalPool: poolAddress,
        newPoolAddress: newPoolAddress?.toString(),
        dammVersion: poolConfig.migrationOption === 0 ? 'v1' : 'v2',
        config: virtualPool.config?.toString(),
        migrationFeeOption: poolConfig.migrationFeeOption,
        message: 'Pool has migrated to DAMM'
      };
    }
    
    console.log('Pool has NOT migrated');
    return {
      migrated: false,
      originalPool: poolAddress,
      message: 'Pool is still in bonding curve phase'
    };
    
  } catch (error) {
    console.error('Error checking pool migration:', error);
    
    // If we can't fetch the pool, it might not exist or there's an RPC issue
    return {
      migrated: false,
      error: error.message,
      originalPool: poolAddress,
      message: 'Failed to check migration status'
    };
  }
}

module.exports = { checkPoolMigration };