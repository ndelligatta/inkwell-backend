// Backend function to claim platform fees from DBC pools
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const bs58 = require('bs58').default;
const { createClient } = require('@supabase/supabase-js');
const { checkPoolMigration } = require('./checkPoolMigration');

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

// Constants
const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Admin wallet keys from environment
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const ADMIN_PUBLIC_KEY = process.env.ADMIN_PUBLIC_KEY || "KAQmut31iGrghKrnaaJbv7FS87ez6JYkDrVPgLDjXnk";

// Config address mapping
const CONFIG_ADDRESS = "FpBnATp3c4i3sVo35u6zyZVpnUEDE6RmVsEofEK1YAMU";

if (!ADMIN_PRIVATE_KEY) {
  console.error('ERROR: Missing required environment variable');
  console.error('Required: ADMIN_PRIVATE_KEY');
  throw new Error('Missing admin private key for fee claiming');
}

// Get fee metrics for a pool
async function getPoolFeeMetrics(poolAddress) {
  try {
    const connection = new Connection(RPC_URL, 'confirmed');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    const poolPubkey = new PublicKey(poolAddress);
    
    console.log(`Fetching fee metrics for pool ${poolAddress}...`);
    const feeMetrics = await dbcClient.state.getPoolFeeMetrics(poolPubkey);
    
    if (feeMetrics && feeMetrics.current) {
      const partnerQuoteFeeSOL = feeMetrics.current.partnerQuoteFee.toNumber() / LAMPORTS_PER_SOL;
      const partnerBaseFee = feeMetrics.current.partnerBaseFee.toString();
      
      return {
        success: true,
        availableFeesSOL: partnerQuoteFeeSOL,
        partnerBaseFee,
        partnerQuoteFee: feeMetrics.current.partnerQuoteFee.toString(),
        hasFeesToClaim: !feeMetrics.current.partnerBaseFee.isZero() || !feeMetrics.current.partnerQuoteFee.isZero()
      };
    }
    
    return {
      success: true,
      availableFeesSOL: 0,
      partnerBaseFee: "0",
      partnerQuoteFee: "0",
      hasFeesToClaim: false
    };
    
  } catch (error) {
    console.error('Error fetching pool fee metrics:', error);
    return {
      success: false,
      error: error.message,
      availableFeesSOL: 0,
      hasFeesToClaim: false
    };
  }
}

// Claim fees from a specific pool
async function claimPoolFees(poolAddress, poolData = {}) {
  try {
    console.log('====== CLAIM PLATFORM FEES START ======');
    console.log('Pool:', poolAddress);
    console.log('Token:', poolData.metadata?.symbol || poolData.symbol || 'Unknown');
    console.log('Config:', poolData.config_address || CONFIG_ADDRESS);
    
    // Initialize connection and client
    const connection = new Connection(RPC_URL, 'confirmed');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    
    // Create keypairs
    const adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_PRIVATE_KEY));
    const poolPubkey = new PublicKey(poolAddress);
    
    console.log('Admin wallet (fee claimer & payer):', adminKeypair.publicKey.toString());
    
    // Verify admin wallet is correct
    if (adminKeypair.publicKey.toString() !== ADMIN_PUBLIC_KEY) {
      throw new Error(`Admin wallet mismatch! Expected ${ADMIN_PUBLIC_KEY}`);
    }
    
    // Get fee metrics
    console.log('Fetching fee metrics...');
    const feeMetrics = await dbcClient.state.getPoolFeeMetrics(poolPubkey);
    
    if (!feeMetrics || !feeMetrics.current) {
      throw new Error('No fee metrics found for pool');
    }
    
    const availableFeesSOL = feeMetrics.current.partnerQuoteFee.toNumber() / LAMPORTS_PER_SOL;
    console.log('Available fees:', availableFeesSOL, 'SOL');
    
    if (feeMetrics.current.partnerBaseFee.isZero() && feeMetrics.current.partnerQuoteFee.isZero()) {
      console.log('No fees found in original pool - checking if pool has migrated...');
      
      // Check if pool has migrated to DAMM
      const migrationStatus = await checkPoolMigration(poolAddress);
      console.log('Migration check result:', migrationStatus);
      
      if (migrationStatus.migrated) {
        // Pool has migrated - return migration info
        return {
          success: false,
          error: 'Pool has migrated to DAMM',
          migrated: true,
          originalPool: poolAddress,
          newPoolAddress: migrationStatus.newPoolAddress,
          dammVersion: migrationStatus.dammVersion,
          config: migrationStatus.config,
          migrationFeeOption: migrationStatus.migrationFeeOption,
          message: 'Fees are now accumulating in the new DAMM pool at ' + migrationStatus.newPoolAddress,
          poolData
        };
      }
      
      // Pool hasn't migrated and no fees available
      throw new Error('No fees available to claim');
    }
    
    // Check admin wallet balance
    console.log('\nChecking wallet state:');
    
    const adminAccountInfo = await connection.getAccountInfo(adminKeypair.publicKey);
    console.log('Admin wallet:');
    console.log('- Balance:', adminAccountInfo ? (adminAccountInfo.lamports / LAMPORTS_PER_SOL).toFixed(6) + ' SOL' : 'Not found');
    console.log('- Data length:', adminAccountInfo?.data.length || 0, 'bytes');
    
    if (!adminAccountInfo || adminAccountInfo.lamports < 0.01 * LAMPORTS_PER_SOL) {
      throw new Error('Admin wallet needs at least 0.01 SOL to pay for transaction fees');
    }
    
    // Create claim transaction
    console.log('\nCreating claim transaction...');
    
    // Use claimPartnerTradingFee - direct claim since new admin wallet has no data
    const claimTx = await dbcClient.partner.claimPartnerTradingFee({
      feeClaimer: adminKeypair.publicKey,
      pool: poolPubkey,
      maxBaseAmount: feeMetrics.current.partnerBaseFee,
      maxQuoteAmount: feeMetrics.current.partnerQuoteFee,
      payer: adminKeypair.publicKey
    });
    
    // Sign and send transaction
    console.log('Signing transaction...');
    claimTx.feePayer = adminKeypair.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    claimTx.recentBlockhash = blockhash;
    claimTx.sign(adminKeypair); // Admin signs as both fee claimer and payer
    
    console.log('Sending transaction...');
    const signature = await connection.sendRawTransaction(
      claimTx.serialize(),
      { 
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3
      }
    );
    
    console.log('Transaction sent:', signature);
    console.log('Waiting for confirmation...');
    
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    }, 'confirmed');
    
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    console.log('✅ Transaction confirmed!');
    console.log('View on Solscan:', `https://solscan.io/tx/${signature}`);
    
    // Verify admin balance after claim
    const adminBalanceAfter = await connection.getBalance(adminKeypair.publicKey);
    console.log('Admin balance after claim:', (adminBalanceAfter / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    
    // Update database if Supabase is available
    if (supabase && poolData.poolAddress) {
      try {
        const { error } = await supabase
          .from('token_pools')
          .update({
            last_fee_claim_at: new Date().toISOString(),
            total_fees_claimed_sol: (parseFloat(poolData.total_fees_claimed_sol || '0') + availableFeesSOL).toString(),
            fee_claim_attempts: (poolData.fee_claim_attempts || 0) + 1
          })
          .eq('pool_address', poolAddress);
        
        if (error) {
          console.error('Failed to update database:', error);
        } else {
          console.log('Database updated successfully');
        }
      } catch (dbError) {
        console.error('Database update error:', dbError);
      }
    }
    
    console.log('====== CLAIM PLATFORM FEES SUCCESS ======');
    
    return {
      success: true,
      signature,
      claimedAmount: availableFeesSOL,
      solscanUrl: `https://solscan.io/tx/${signature}`,
      receiverWallet: adminKeypair.publicKey.toString()
    };
    
  } catch (error) {
    console.error('====== CLAIM PLATFORM FEES ERROR ======');
    console.error('Error:', error);
    
    return {
      success: false,
      error: error.message || 'Unknown error',
      details: error.toString()
    };
  }
}

// Get all pools with fees from database
async function getPoolsWithFees() {
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  try {
    const { data, error } = await supabase
      .from('token_pools')
      .select('*')
      .eq('pool_type', 'dbc')
      .eq('status', 'active')
      .eq('config_address', CONFIG_ADDRESS)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    return data || [];
  } catch (error) {
    console.error('Error fetching pools:', error);
    throw error;
  }
}

// Claim all available fees
async function claimAllPlatformFees() {
  try {
    console.log('====== CLAIMING ALL PLATFORM FEES ======');
    
    const pools = await getPoolsWithFees();
    console.log(`Found ${pools.length} active pools`);
    
    let successCount = 0;
    let totalClaimed = 0;
    const results = [];
    
    for (const pool of pools) {
      console.log(`\nChecking pool ${pool.pool_address}...`);
      
      // Get fee metrics
      const metrics = await getPoolFeeMetrics(pool.pool_address);
      
      if (metrics.success && metrics.hasFeesToClaim) {
        console.log(`Pool has ${metrics.availableFeesSOL} SOL to claim`);
        
        // Claim fees
        const result = await claimPoolFees(pool.pool_address, {
          symbol: pool.metadata?.symbol,
          total_fees_claimed_sol: pool.total_fees_claimed_sol,
          fee_claim_attempts: pool.fee_claim_attempts
        });
        
        if (result.success) {
          successCount++;
          totalClaimed += result.claimedAmount;
          results.push({
            pool: pool.pool_address,
            token: pool.metadata?.symbol || 'Unknown',
            claimed: result.claimedAmount,
            signature: result.signature
          });
        } else {
          console.error(`Failed to claim from pool ${pool.pool_address}:`, result.error);
        }
        
        // Small delay between claims
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        console.log('No fees to claim from this pool');
      }
    }
    
    console.log('\n====== SUMMARY ======');
    console.log(`Successfully claimed from ${successCount} pools`);
    console.log(`Total claimed: ${totalClaimed.toFixed(6)} SOL`);
    
    return {
      success: true,
      poolsProcessed: pools.length,
      successCount,
      totalClaimedSOL: totalClaimed,
      results
    };
    
  } catch (error) {
    console.error('Error claiming all fees:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Export functions
module.exports = {
  claimPoolFees,
  getPoolFeeMetrics,
  claimAllPlatformFees,
  getPoolsWithFees
};

// If run directly, execute claim all
if (require.main === module) {
  claimAllPlatformFees()
    .then(result => {
      if (result.success) {
        console.log('\n✅ All fees claimed successfully!');
        process.exit(0);
      } else {
        console.error('\n❌ Fee claiming failed');
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('Unexpected error:', error);
      process.exit(1);
    });
}