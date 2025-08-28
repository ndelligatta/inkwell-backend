// Claim fees from DAMM v2 pools using position NFTs
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const { CpAmm } = require('@meteora-ag/cp-amm-sdk');
const bs58 = require('bs58').default;
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

// Constants
const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Admin wallet keys from environment
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const ADMIN_PUBLIC_KEY = process.env.ADMIN_PUBLIC_KEY || "KAQmut31iGrghKrnaaJbv7FS87ez6JYkDrVPgLDjXnk";

// Helper to determine token program
function getTokenProgram(tokenFlag) {
  return tokenFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

// Helper function to retry RPC calls
async function retryRpcCall(fn, maxRetries = 3, delayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      console.log(`RPC call attempt ${i + 1} failed:`, error.message);
      if (i === maxRetries - 1) throw error;
      console.log(`Retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

async function claimDammV2Fees(poolAddress, poolData = {}) {
  try {
    console.log('====== CLAIM DAMM V2 FEES START ======');
    console.log('Pool:', poolAddress);
    console.log('Token:', poolData.metadata?.symbol || poolData.symbol || 'Unknown');
    
    if (!ADMIN_PRIVATE_KEY) {
      throw new Error('Missing admin private key for fee claiming');
    }
    
    // Initialize connection with timeout config
    const connection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
      httpHeaders: {
        'solana-client': 'inkwell-damm-v2'
      }
    });
    
    // Create keypair
    const adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_PRIVATE_KEY));
    console.log('Admin wallet:', adminKeypair.publicKey.toString());
    
    // Verify admin wallet is correct
    if (adminKeypair.publicKey.toString() !== ADMIN_PUBLIC_KEY) {
      throw new Error(`Admin wallet mismatch! Expected ${ADMIN_PUBLIC_KEY}`);
    }
    
    // Initialize CP AMM client
    const cpAmm = new CpAmm(connection);
    const poolPubkey = new PublicKey(poolAddress);
    
    // Get pool state
    console.log('Fetching pool state...');
    const poolState = await retryRpcCall(
      () => cpAmm.fetchPoolState(poolPubkey),
      3,
      2000
    );
    console.log('Pool state fetched, token A:', poolState.tokenAMint.toString());
    console.log('Token B:', poolState.tokenBMint.toString());
    
    // Find all positions for this pool owned by admin
    console.log('\nFinding positions for admin wallet...');
    const userPositions = await retryRpcCall(
      () => cpAmm.getUserPositionByPool(
        poolPubkey,
        adminKeypair.publicKey
      ),
      3,
      2000
    );
    
    if (!userPositions || userPositions.length === 0) {
      console.log('No positions found for admin wallet');
      
      // Check if there's a lock escrow account
      console.log('Checking for lock escrow positions...');
      // TODO: Implement lock escrow check
      
      return {
        success: false,
        error: 'No positions found for admin wallet',
        positions: 0,
        poolAddress
      };
    }
    
    console.log(`Found ${userPositions.length} positions`);
    
    // Debug first position structure
    if (userPositions.length > 0) {
      console.log('\nFirst position structure:');
      console.log(JSON.stringify(userPositions[0], (key, value) => 
        typeof value === 'object' && value?.toString ? value.toString() : value
      , 2));
    }
    
    let totalClaimed = 0;
    const results = [];
    
    // Claim fees from each position
    for (let i = 0; i < userPositions.length; i++) {
      const position = userPositions[i];
      console.log(`\nProcessing position ${i + 1}/${userPositions.length}...`);
      console.log('Position object keys:', Object.keys(position));
      console.log('Position address:', position.position?.toString());
      console.log('Position NFT:', position.positionNftAccount?.toString());
      
      try {
        // Validate position data
        if (!position.position || !position.positionNftAccount) {
          console.error('Invalid position data:', position);
          continue;
        }
        
        // Create claim transaction using claimPositionFee2
        const claimPositionFeesTx = await cpAmm.claimPositionFee2({
          receiver: adminKeypair.publicKey,
          owner: adminKeypair.publicKey,
          pool: poolPubkey,
          position: position.position,
          positionNftAccount: position.positionNftAccount,
          tokenAVault: poolState.tokenAVault,
          tokenBVault: poolState.tokenBVault,
          tokenAMint: poolState.tokenAMint,
          tokenBMint: poolState.tokenBMint,
          tokenAProgram: getTokenProgram(poolState.tokenAFlag),
          tokenBProgram: getTokenProgram(poolState.tokenBFlag),
          feePayer: adminKeypair.publicKey, // Add explicit fee payer
        });
        
        // Set fee payer and blockhash
        claimPositionFeesTx.feePayer = adminKeypair.publicKey;
        const { blockhash, lastValidBlockHeight } = await retryRpcCall(
          () => connection.getLatestBlockhash('confirmed'),
          3,
          2000
        );
        claimPositionFeesTx.recentBlockhash = blockhash;
        
        // Simulate transaction first
        console.log('Simulating transaction...');
        const simulation = await connection.simulateTransaction(claimPositionFeesTx);
        
        if (simulation.value.err) {
          console.error('Simulation failed:', simulation.value.err);
          continue;
        }
        
        console.log('Simulation successful, sending transaction...');
        
        // Send transaction
        const signature = await sendAndConfirmTransaction(
          connection,
          claimPositionFeesTx,
          [adminKeypair],
          {
            commitment: 'confirmed',
            maxRetries: 3
          }
        );
        
        console.log('✅ Position fees claimed!');
        console.log('Transaction:', signature);
        console.log('View on Solscan:', `https://solscan.io/tx/${signature}`);
        
        results.push({
          position: position.position.toString(),
          signature,
          success: true
        });
        
        // TODO: Calculate actual claimed amount from transaction logs
        totalClaimed += 0.1; // Placeholder
        
      } catch (error) {
        console.error(`Error claiming position ${i + 1}:`, error.message);
        console.error('Full error:', error);
        results.push({
          position: position.position ? position.position.toString() : 'unknown',
          error: error.message,
          success: false
        });
      }
      
      // Small delay between claims
      if (i < userPositions.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log('\n====== CLAIM DAMM V2 FEES SUCCESS ======');
    console.log(`Claimed from ${results.filter(r => r.success).length}/${userPositions.length} positions`);
    
    return {
      success: true,
      positionsProcessed: userPositions.length,
      successfulClaims: results.filter(r => r.success).length,
      totalClaimedSOL: totalClaimed,
      results,
      poolAddress
    };
    
  } catch (error) {
    console.error('====== CLAIM DAMM V2 FEES ERROR ======');
    console.error('Error:', error);
    
    return {
      success: false,
      error: error.message || 'Unknown error',
      details: error.toString()
    };
  }
}

// Export function
module.exports = {
  claimDammV2Fees
};

// Test if run directly
if (require.main === module) {
  const poolAddress = process.argv[2];
  if (!poolAddress) {
    console.error('Usage: node claimDammV2Fees.js <POOL_ADDRESS>');
    process.exit(1);
  }
  
  claimDammV2Fees(poolAddress)
    .then(result => {
      console.log('\nResult:', JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Unexpected error:', error);
      process.exit(1);
    });
}