// Script to find the proper migrated pool address using Meteora SDK
const { Connection, PublicKey } = require('@solana/web3.js');
const { 
  DynamicBondingCurveClient,
  deriveDammV1PoolAddress,
  deriveDammV2PoolAddress,
  DAMM_V1_MIGRATION_FEE_ADDRESS,
  DAMM_V2_MIGRATION_FEE_ADDRESS
} = require('@meteora-ag/dynamic-bonding-curve-sdk');

// Test data
const PRE_MIGRATION_POOL = "DMMkjnyCg89tYPYNZAcFXdt9djWCCbyQwWvvXg1cZuQR";
const TOKEN_MINT = "BZnmwStz8iapHZoM5YRbvf563qAShUvN28PJDDHvpRTy";
const CONFIG_ADDRESS = "4wGDGetHZYw6c6MJkiqz8LL5nHMnWvgLGTcF7dypSzGi";
const QUOTE_MINT = "So11111111111111111111111111111111111111112"; // SOL

const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

async function findMigratedPool() {
  try {
    console.log('====== FINDING MIGRATED POOL ADDRESS ======');
    console.log('Pre-migration DBC Pool:', PRE_MIGRATION_POOL);
    console.log('Token Mint:', TOKEN_MINT);
    console.log('Config Address:', CONFIG_ADDRESS);
    console.log('');

    // Initialize connection and client
    const connection = new Connection(RPC_URL, 'confirmed');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');

    // First, check the pre-migration pool status
    console.log('Checking pre-migration pool status...');
    const poolPubkey = new PublicKey(PRE_MIGRATION_POOL);
    
    try {
      const poolState = await dbcClient.state.getPool(poolPubkey);
      console.log('Pre-migration pool found!');
      console.log('Is Migrated:', poolState.isMigrated);
      console.log('Base Mint:', poolState.baseMint.toString());
      console.log('Quote Mint:', poolState.quoteMint.toString());
      console.log('Config:', poolState.config.toString());
    } catch (error) {
      console.log('Could not fetch pre-migration pool state:', error.message);
    }

    // Get the pool config to determine migration fee option
    console.log('\nFetching pool config...');
    const configPubkey = new PublicKey(CONFIG_ADDRESS);
    const poolConfigState = await dbcClient.state.getPoolConfig(configPubkey);
    
    console.log('Pool Config fetched!');
    console.log('Migration Fee Option:', poolConfigState.migrationFeeOption);
    console.log('Trading Fee Bps:', poolConfigState.tradingFeesBps);
    console.log('Platform Fee Bps:', poolConfigState.platformFeesBps);

    // Convert mints to PublicKey
    const baseMint = new PublicKey(TOKEN_MINT);
    const quoteMint = new PublicKey(QUOTE_MINT);

    // Derive DAMM v1 pool address
    console.log('\nDeriving DAMM v1 pool address...');
    const dammV1Config = DAMM_V1_MIGRATION_FEE_ADDRESS[poolConfigState.migrationFeeOption];
    console.log('DAMM v1 Config:', dammV1Config.toString());
    
    const dammV1PoolAddress = deriveDammV1PoolAddress(
      dammV1Config,
      baseMint,
      quoteMint
    );
    console.log('DAMM v1 Pool Address:', dammV1PoolAddress.toString());

    // Derive DAMM v2 pool address
    console.log('\nDeriving DAMM v2 pool address...');
    const dammV2Config = DAMM_V2_MIGRATION_FEE_ADDRESS[poolConfigState.migrationFeeOption];
    console.log('DAMM v2 Config:', dammV2Config.toString());
    
    const dammV2PoolAddress = deriveDammV2PoolAddress(
      dammV2Config,
      baseMint,
      quoteMint
    );
    console.log('DAMM v2 Pool Address:', dammV2PoolAddress.toString());

    // Check which pool exists
    console.log('\nChecking which pool exists...');
    
    // Check DAMM v1
    try {
      const v1Account = await connection.getAccountInfo(dammV1PoolAddress);
      if (v1Account) {
        console.log('✅ DAMM v1 pool EXISTS at:', dammV1PoolAddress.toString());
        console.log('  Owner:', v1Account.owner.toString());
        console.log('  Data length:', v1Account.data.length);
      } else {
        console.log('❌ DAMM v1 pool does not exist');
      }
    } catch (error) {
      console.log('❌ Error checking DAMM v1:', error.message);
    }

    // Check DAMM v2
    try {
      const v2Account = await connection.getAccountInfo(dammV2PoolAddress);
      if (v2Account) {
        console.log('✅ DAMM v2 pool EXISTS at:', dammV2PoolAddress.toString());
        console.log('  Owner:', v2Account.owner.toString());
        console.log('  Data length:', v2Account.data.length);
      } else {
        console.log('❌ DAMM v2 pool does not exist');
      }
    } catch (error) {
      console.log('❌ Error checking DAMM v2:', error.message);
    }

    // Also check the pool from the database (5LU223t4zWhmC9duVkRdnnFJhvtHSHHsfCfNFz98i1Jg)
    console.log('\nChecking the pool found by Jupiter (5LU223t4zWhmC9duVkRdnnFJhvtHSHHsfCfNFz98i1Jg)...');
    const jupiterPool = new PublicKey('5LU223t4zWhmC9duVkRdnnFJhvtHSHHsfCfNFz98i1Jg');
    try {
      const jupiterAccount = await connection.getAccountInfo(jupiterPool);
      if (jupiterAccount) {
        console.log('✅ Jupiter pool EXISTS');
        console.log('  Owner:', jupiterAccount.owner.toString());
        console.log('  Data length:', jupiterAccount.data.length);
        
        // Check if this matches our derived addresses
        if (jupiterPool.equals(dammV1PoolAddress)) {
          console.log('  ✅ This matches the derived DAMM v1 address!');
        } else if (jupiterPool.equals(dammV2PoolAddress)) {
          console.log('  ✅ This matches the derived DAMM v2 address!');
        } else {
          console.log('  ⚠️  This does NOT match our derived addresses');
        }
      }
    } catch (error) {
      console.log('❌ Error checking Jupiter pool:', error.message);
    }

  } catch (error) {
    console.error('\nError:', error);
    console.error('Stack:', error.stack);
  }
}

// Run the script
findMigratedPool();