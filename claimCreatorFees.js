// Backend function to claim creator fees from DBC pools
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const { 
  DynamicBondingCurveClient,
  deriveDammV1MigrationMetadataAddress,
  deriveDammV2MigrationMetadataAddress,
  deriveDammV2PoolAddress,
  DAMM_V1_MIGRATION_FEE_ADDRESS,
  DAMM_V2_MIGRATION_FEE_ADDRESS
} = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { CpAmm } = require('@meteora-ag/cp-amm-sdk');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58').default;
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
) : null;

// Constants
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const FALLBACK_RPC = "https://api.mainnet-beta.solana.com";
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds

// Check pool migration using official SDK
async function checkPoolMigrationOfficial(poolAddress, connection) {
  try {
    const poolPubkey = new PublicKey(poolAddress);
    
    // Check DAMM v2 migration first using official SDK
    const v2Metadata = deriveDammV2MigrationMetadataAddress(poolPubkey);
    const v2Account = await connection.getAccountInfo(v2Metadata);
    
    if (v2Account) {
      console.log('Found DAMM v2 migration metadata');
      return {
        migrated: true,
        dammVersion: 'v2',
        migrationMetadata: v2Metadata,
        originalPool: poolAddress
      };
    }
    
    // Check DAMM v1 migration using official SDK
    const v1Metadata = deriveDammV1MigrationMetadataAddress(poolPubkey);
    const v1Account = await connection.getAccountInfo(v1Metadata);
    
    if (v1Account) {
      console.log('Found DAMM v1 migration metadata');
      return {
        migrated: true,
        dammVersion: 'v1', 
        migrationMetadata: v1Metadata,
        originalPool: poolAddress
      };
    }
    
    return { migrated: false };
  } catch (error) {
    console.error('Error checking migration with official SDK:', error);
    return { migrated: false, error: error.message };
  }
}

// Get migrated pool address using official SDK
async function getMigratedPoolAddress(poolAddress, connection, dammVersion) {
  try {
    const poolPubkey = new PublicKey(poolAddress);
    
    if (dammVersion === 'v2') {
      // Get pool state to extract token mints
      const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
      let poolState;
      
      try {
        poolState = await dbcClient.state.getPool(poolPubkey);
      } catch (error) {
        // If pool state fails, try to get from migration metadata
        console.log('Failed to get pool state, trying migration metadata...');
        throw new Error('Cannot retrieve token mints from migrated pool');
      }
      
      if (!poolState || !poolState.baseMint || !poolState.quoteMint) {
        throw new Error('Invalid pool state - missing token mints');
      }
      
      // Try each DAMM v2 config to find the migrated pool
      for (let i = 0; i < DAMM_V2_MIGRATION_FEE_ADDRESS.length; i++) {
        const config = DAMM_V2_MIGRATION_FEE_ADDRESS[i];
        
        // Use the official derivation function
        const migratedPoolAddress = deriveDammV2PoolAddress(
          config,
          poolState.baseMint,
          poolState.quoteMint
        );
        
        // Check if this pool exists
        const poolAccount = await connection.getAccountInfo(migratedPoolAddress);
        if (poolAccount) {
          console.log(`Found migrated pool at: ${migratedPoolAddress.toString()}`);
          return migratedPoolAddress;
        }
      }
    }
    
    throw new Error(`No migrated pool found for ${dammVersion}`);
  } catch (error) {
    console.error('Error getting migrated pool address:', error);
    throw error;
  }
}

// Claim ALL positions from DAMM v2 pool
async function claimAllDammV2Positions(migratedPoolAddress, creatorKeypair, connection) {
  try {
    const cpAmm = new CpAmm(connection);
    const poolPubkey = new PublicKey(migratedPoolAddress);
    
    console.log('Fetching DAMM v2 pool state...');
    const poolState = await cpAmm.fetchPoolState(poolPubkey);
    
    console.log('Finding ALL positions for creator wallet:', creatorKeypair.publicKey.toString());
    
    // Get ALL positions for the creator wallet
    const userPositions = await cpAmm.getUserPositionByPool(
      poolPubkey,
      creatorKeypair.publicKey
    );
    
    if (!userPositions || userPositions.length === 0) {
      return {
        success: false,
        error: 'No positions found for creator wallet in DAMM v2 pool',
        positionsClaimed: 0
      };
    }
    
    console.log(`Found ${userPositions.length} positions for creator - claiming ALL positions`);
    
    const claimResults = [];
    let totalClaimed = 0;
    
    // Helper to determine token program
    function getTokenProgram(tokenFlag) {
      return tokenFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    }
    
    // CLAIM EACH POSITION
    for (const position of userPositions) {
      try {
        console.log(`Claiming position ${position.position.toString()}...`);
        
        const claimTx = await cpAmm.claimPositionFee2({
          receiver: creatorKeypair.publicKey,
          owner: creatorKeypair.publicKey,
          pool: poolPubkey,
          position: position.position,
          positionNftAccount: position.positionNftAccount,
          tokenAVault: poolState.tokenAVault,
          tokenBVault: poolState.tokenBVault,
          tokenAMint: poolState.tokenAMint,
          tokenBMint: poolState.tokenBMint,
          tokenAProgram: getTokenProgram(poolState.tokenAFlag),
          tokenBProgram: getTokenProgram(poolState.tokenBFlag),
          feePayer: creatorKeypair.publicKey,
        });
        
        // Sign and send
        claimTx.feePayer = creatorKeypair.publicKey;
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        claimTx.recentBlockhash = blockhash;
        
        const signature = await sendAndConfirmTransaction(
          connection,
          claimTx,
          [creatorKeypair],
          {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            commitment: 'confirmed',
            maxRetries: 3
          }
        );
        
        claimResults.push({
          position: position.position.toString(),
          signature: signature,
          success: true
        });
        
        console.log(`✅ Claimed position ${position.position.toString()}: ${signature}`);
        totalClaimed++;
        
      } catch (error) {
        console.error(`Failed to claim position ${position.position.toString()}:`, error);
        claimResults.push({
          position: position.position.toString(),
          success: false,
          error: error.message
        });
      }
    }
    
    return {
      success: totalClaimed > 0,
      positionsClaimed: totalClaimed,
      totalPositions: userPositions.length,
      results: claimResults
    };
  } catch (error) {
    console.error('Error claiming DAMM v2 positions:', error);
    throw error;
  }
}

// Claim fees from a single pool
async function claimCreatorFees(poolAddress, creatorPrivateKey, userId) {
  try {
    console.log('====== CLAIM CREATOR FEES START ======');
    console.log('Pool:', poolAddress);
    console.log('User ID:', userId);
    
    // Initialize connection with timeout config like platform fees
    let connection;
    let dbcClient;
    let connectionAttempt = 0;
    let lastError;
    
    // Try primary RPC first, then fallback
    const rpcUrls = [RPC_URL, FALLBACK_RPC];
    
    for (const rpcUrl of rpcUrls) {
      try {
        console.log(`Trying RPC: ${rpcUrl === RPC_URL ? 'Helius' : 'Fallback'} endpoint...`);
        connection = new Connection(rpcUrl, {
          commitment: 'confirmed',
          confirmTransactionInitialTimeout: 60000,
          httpHeaders: {
            'solana-client': 'inkwell-creator'
          }
        });
        
        // Test connection with a simple call
        await connection.getLatestBlockhash('confirmed');
        dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
        console.log('Connection established successfully');
        break;
      } catch (error) {
        console.error(`Failed to connect to ${rpcUrl === RPC_URL ? 'Helius' : 'Fallback'} RPC:`, error.message);
        lastError = error;
        if (rpcUrl === FALLBACK_RPC) {
          throw new Error(`All RPC endpoints failed: ${lastError.message}`);
        }
      }
    }
    
    // Create keypair from creator private key (try base58 first, then base64)
    let creatorKeypair;
    try {
      creatorKeypair = Keypair.fromSecretKey(bs58.decode(creatorPrivateKey));
      console.log('Using base58 encoded private key, wallet:', creatorKeypair.publicKey.toString());
    } catch {
      try {
        creatorKeypair = Keypair.fromSecretKey(Buffer.from(creatorPrivateKey, 'base64'));
        console.log('Using base64 encoded private key, wallet:', creatorKeypair.publicKey.toString());
      } catch {
        // Try JSON array format
        const keyArray = JSON.parse(creatorPrivateKey);
        creatorKeypair = Keypair.fromSecretKey(new Uint8Array(keyArray));
        console.log('Using JSON array private key, wallet:', creatorKeypair.publicKey.toString());
      }
    }
    
    // Get fee metrics with error handling
    console.log('Fetching fee metrics...');
    const poolPubkey = new PublicKey(poolAddress);
    let feeMetrics;
    
    // Retry logic for fee metrics
    let retries = 0;
    while (retries < MAX_RETRIES) {
      try {
        feeMetrics = await dbcClient.state.getPoolFeeMetrics(poolPubkey);
        break; // Success, exit retry loop
      } catch (error) {
        retries++;
        console.error(`Failed to fetch fee metrics (attempt ${retries}/${MAX_RETRIES}):`, error.message);
        
        if (retries === MAX_RETRIES) {
          // Final attempt failed
          console.error('All retry attempts exhausted');
      
          // On connection error, check if pool has migrated using official SDK
          console.log('Checking if pool has migrated using official SDK...');
          const migrationStatus = await checkPoolMigrationOfficial(poolAddress, connection);
          console.log('Migration check result:', migrationStatus);
      
          if (migrationStatus.migrated) {
            // Get the migrated pool address
            const migratedPoolAddress = await getMigratedPoolAddress(poolAddress, connection, migrationStatus.dammVersion);
            
            return {
              success: false,
              error: 'Pool has migrated to DAMM',
              migrated: true,
              originalPool: poolAddress,
              newPoolAddress: migratedPoolAddress.toString(),
              dammVersion: migrationStatus.dammVersion,
              message: `Pool has migrated to DAMM ${migrationStatus.dammVersion} at ${migratedPoolAddress.toString()}`
            };
          }
          
          // Re-throw if not migration related
          throw error;
        }
        
        // Wait before retry
        console.log(`Waiting ${RETRY_DELAY}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
    
    if (!feeMetrics || !feeMetrics.current) {
      throw new Error('No fee metrics found for pool');
    }
    
    console.log('Fee metrics breakdown:', {
      creatorBaseFee: feeMetrics.current.creatorBaseFee.toString(),
      creatorQuoteFee: feeMetrics.current.creatorQuoteFee.toString(),
      creatorQuoteFeeSOL: feeMetrics.current.creatorQuoteFee.toNumber() / LAMPORTS_PER_SOL
    });
    
    // Check if there are fees to claim
    if (feeMetrics.current.creatorBaseFee.isZero() && feeMetrics.current.creatorQuoteFee.isZero()) {
      console.log('No fees found in original pool - checking if pool has migrated...');
      
      // Check if pool has migrated to DAMM using official SDK
      const migrationStatus = await checkPoolMigrationOfficial(poolAddress, connection);
      console.log('Migration check result:', migrationStatus);
      
      if (migrationStatus.migrated) {
        // Pool has migrated - attempt to claim from DAMM pool
        console.log(`Pool migrated to ${migrationStatus.dammVersion}`);
        console.log('Getting migrated pool address...');
        
        if (migrationStatus.dammVersion === 'v2') {
          try {
            // Get the migrated pool address using official SDK
            const migratedPoolAddress = await getMigratedPoolAddress(poolAddress, connection, migrationStatus.dammVersion);
            console.log('Migrated pool address:', migratedPoolAddress.toString());
            
            // Use the new function to claim ALL positions
            const claimResult = await claimAllDammV2Positions(migratedPoolAddress.toString(), creatorKeypair, connection);
            
            if (claimResult.success) {
              return {
                success: true,
                migrated: true,
                originalPool: poolAddress,
                newPoolAddress: migratedPoolAddress.toString(),
                dammVersion: migrationStatus.dammVersion,
                positionsClaimed: claimResult.positionsClaimed,
                totalPositions: claimResult.totalPositions,
                results: claimResult.results,
                message: `Successfully claimed ${claimResult.positionsClaimed} of ${claimResult.totalPositions} positions from DAMM v2 pool`
              };
            } else {
              return {
                success: false,
                error: claimResult.error || 'Failed to claim from DAMM v2',
                migrated: true,
                originalPool: poolAddress,
                newPoolAddress: migratedPoolAddress.toString(),
                dammVersion: migrationStatus.dammVersion,
                positionsClaimed: claimResult.positionsClaimed || 0,
                totalPositions: claimResult.totalPositions || 0,
                message: claimResult.error
              };
            }
            
          } catch (dammError) {
            console.error('Error claiming from DAMM v2:', dammError);
            return {
              success: false,
              error: dammError.message || 'Failed to claim from DAMM v2',
              migrated: true,
              originalPool: poolAddress,
              dammVersion: migrationStatus.dammVersion,
              details: dammError.toString()
            };
          }
        } else {
          // DAMM v1 not yet implemented
          return {
            success: false,
            error: 'DAMM v1 fee claiming not yet implemented',
            migrated: true,
            originalPool: poolAddress,
            newPoolAddress: migrationStatus.newPoolAddress,
            dammVersion: migrationStatus.dammVersion,
            message: 'Pool migrated to DAMM v1 - fee claiming not yet implemented'
          };
        }
      }
      
      // Pool hasn't migrated and no fees available
      return {
        success: false,
        error: 'No creator fees available to claim',
        migrated: false,
        originalPool: poolAddress,
        message: 'No fees available and pool has not migrated'
      };
    }
    
    // Check SOL balance for transaction fees
    const balance = await connection.getBalance(creatorKeypair.publicKey);
    const MIN_SOL_FOR_FEES = 0.01 * LAMPORTS_PER_SOL;
    if (balance < MIN_SOL_FOR_FEES) {
      throw new Error(`Insufficient SOL balance for transaction fees. Need at least 0.01 SOL. Current balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    }
    
    // Create claim transaction
    console.log('Creating claim transaction...');
    const claimTx = await dbcClient.creator.claimCreatorTradingFee({
      creator: creatorKeypair.publicKey,
      pool: poolPubkey,
      maxBaseAmount: feeMetrics.current.creatorBaseFee,
      maxQuoteAmount: feeMetrics.current.creatorQuoteFee,
      payer: creatorKeypair.publicKey,
    });
    
    // Sign and send transaction
    console.log('Signing transaction...');
    claimTx.feePayer = creatorKeypair.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    claimTx.recentBlockhash = blockhash;
    claimTx.sign(creatorKeypair);
    
    console.log('Sending transaction...');
    let signature;
    let sendRetries = 0;
    
    while (sendRetries < MAX_RETRIES) {
      try {
        signature = await connection.sendRawTransaction(
          claimTx.serialize(),
          { 
            skipPreflight: true,
            maxRetries: 2
          }
        );
        break;
      } catch (error) {
        sendRetries++;
        console.error(`Failed to send transaction (attempt ${sendRetries}/${MAX_RETRIES}):`, error.message);
        
        if (sendRetries === MAX_RETRIES) {
          throw new Error(`Failed to send transaction after ${MAX_RETRIES} attempts: ${error.message}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
    
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
    
    // Update database with claim info
    if (supabase) {
      try {
        // Find the post associated with this pool
        const { data: post } = await supabase
          .from('user_posts')
          .select('id, total_fees_claimed_sol, fee_claim_attempts')
          .eq('pool_address', poolAddress)
          .single();
          
        if (post) {
          const solClaimed = feeMetrics.current.creatorQuoteFee.toNumber() / LAMPORTS_PER_SOL;
          
          // Update post with new claim totals
          await supabase
            .from('user_posts')
            .update({
              total_fees_claimed_sol: (parseFloat(post.total_fees_claimed_sol || '0') + solClaimed).toString(),
              last_fee_claim_at: new Date().toISOString(),
              fee_claim_attempts: (post.fee_claim_attempts || 0) + 1
            })
            .eq('id', post.id);
            
          // Log to claim history
          await supabase
            .from('post_fee_claim_history')
            .insert({
              post_id: post.id,
              pool_address: poolAddress,
              base_fees_claimed: feeMetrics.current.creatorBaseFee.toNumber(),
              quote_fees_claimed: feeMetrics.current.creatorQuoteFee.toNumber(),
              sol_amount: solClaimed,
              transaction_signature: signature,
              claimer_address: creatorKeypair.publicKey.toString(),
              success: true
            });
            
          console.log('Database updated successfully');
          
          // Also update the total_fees_claimed in user_posts
          // First get current value
          const { data: currentPost, error: fetchError } = await supabase
            .from('user_posts')
            .select('total_fees_claimed')
            .eq('pool_address', poolAddress)
            .single();
            
          if (!fetchError && currentPost) {
            const currentClaimed = parseFloat(currentPost.total_fees_claimed || '0');
            const newTotal = currentClaimed + solClaimed;
            
            const { error: updateError } = await supabase
              .from('user_posts')
              .update({
                total_fees_claimed: newTotal
              })
              .eq('pool_address', poolAddress);
              
            if (updateError) {
              console.error('Failed to update total_fees_claimed:', updateError);
            } else {
              console.log(`Updated total_fees_claimed: ${currentClaimed} + ${solClaimed} = ${newTotal} SOL`);
            }
          }
        }
      } catch (dbError) {
        console.error('Failed to update database:', dbError);
        // Don't fail the claim if DB update fails
      }
    }
    
    console.log('====== CLAIM CREATOR FEES SUCCESS ======');
    
    return {
      success: true,
      baseFeesClaimed: feeMetrics.current.creatorBaseFee.toString(),
      quoteFeesClaimed: feeMetrics.current.creatorQuoteFee.toString(),
      transactionSignature: signature,
      solscanUrl: `https://solscan.io/tx/${signature}`
    };
    
  } catch (error) {
    console.error('====== CLAIM CREATOR FEES ERROR ======');
    console.error('Error:', error);
    
    return {
      success: false,
      error: error.message || 'Unknown error',
      details: error.toString()
    };
  }
}

// Claim all fees for a creator
async function claimAllCreatorFees(userId, creatorPrivateKey) {
  try {
    console.log('====== CLAIMING ALL CREATOR FEES ======');
    console.log('User ID:', userId);
    
    if (!supabase) {
      throw new Error('Supabase client not initialized');
    }
    
    // Get all pools created by this user
    let { data: posts, error: postsError } = await supabase
      .from('user_posts')
      .select('pool_address, token_mint, metadata')
      .eq('user_id', userId)
      .not('pool_address', 'is', null);
    
    // If no pools in user_posts, check token_pools table
    if ((!posts || posts.length === 0) && !postsError) {
      const poolsResult = await supabase
        .from('token_pools')
        .select('pool_address, token_mint, metadata')
        .eq('pool_type', 'dbc')
        .eq('status', 'active')
        .eq('user_id', userId)
        .not('pool_address', 'is', null);
      
      posts = poolsResult.data;
      postsError = poolsResult.error;
    }
    
    if (postsError || !posts || posts.length === 0) {
      return {
        success: false,
        error: 'No pools found for this creator',
        poolsProcessed: 0
      };
    }
    
    console.log(`Found ${posts.length} pools to process`);
    
    let successCount = 0;
    let totalQuoteFees = 0;
    let totalBaseFees = 0;
    const results = [];
    
    for (const post of posts) {
      console.log(`\nProcessing pool ${post.pool_address}...`);
      
      try {
        const result = await claimCreatorFees(post.pool_address, creatorPrivateKey, userId);
        
        if (result.success) {
          successCount++;
          totalQuoteFees += parseFloat(result.quoteFeesClaimed) / LAMPORTS_PER_SOL;
          totalBaseFees += parseFloat(result.baseFeesClaimed);
          
          results.push({
            pool: post.pool_address,
            token: post.metadata?.symbol || 'Unknown',
            claimed: parseFloat(result.quoteFeesClaimed) / LAMPORTS_PER_SOL,
            signature: result.transactionSignature
          });
        } else {
          console.error(`Failed to claim from pool ${post.pool_address}:`, result.error);
        }
      } catch (error) {
        console.error(`Error processing pool ${post.pool_address}:`, error);
      }
      
      // Small delay between claims
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('\n====== SUMMARY ======');
    console.log(`Successfully claimed from ${successCount} pools`);
    console.log(`Total claimed: ${totalQuoteFees.toFixed(6)} SOL`);
    
    return {
      success: true,
      poolsProcessed: posts.length,
      successfulClaims: successCount,
      totalQuoteFeesClaimed: (totalQuoteFees * LAMPORTS_PER_SOL).toString(),
      totalBaseFeesClaimed: totalBaseFees.toString(),
      results
    };
    
  } catch (error) {
    console.error('Error claiming all fees:', error);
    return {
      success: false,
      error: error.message || 'Unknown error'
    };
  }
}

// Check available creator fees without claiming
async function checkAvailableCreatorFees(poolAddress) {
  try {
    console.log(`Checking fees for pool: ${poolAddress}`);
    
    // Try primary RPC first, then fallback
    let connection;
    let dbcClient;
    const rpcUrls = [RPC_URL, FALLBACK_RPC];
    
    for (const rpcUrl of rpcUrls) {
      try {
        connection = new Connection(rpcUrl, {
          commitment: 'confirmed',
          httpHeaders: {
            'solana-client': 'inkwell-creator'
          }
        });
        await connection.getLatestBlockhash('confirmed');
        dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
        break;
      } catch (error) {
        console.error(`Failed to connect to RPC:`, error.message);
        if (rpcUrl === FALLBACK_RPC) {
          throw new Error('All RPC endpoints failed');
        }
      }
    }
    
    // Get fee metrics directly
    const feeMetrics = await dbcClient.state.getPoolFeeMetrics(new PublicKey(poolAddress));
    
    if (!feeMetrics || !feeMetrics.current) {
      return {
        success: false,
        error: 'No fee metrics available for this pool'
      };
    }
    
    return {
      success: true,
      creatorBaseFee: feeMetrics.current.creatorBaseFee.toString(),
      creatorQuoteFee: feeMetrics.current.creatorQuoteFee.toString(),
      creatorQuoteFeeSOL: feeMetrics.current.creatorQuoteFee.toNumber() / LAMPORTS_PER_SOL
    };
  } catch (error) {
    console.error('Error checking fees:', error);
    return {
      success: false,
      error: error.message || 'Unknown error'
    };
  }
}

// Export functions
module.exports = {
  claimCreatorFees,
  claimAllCreatorFees,
  checkAvailableCreatorFees
};