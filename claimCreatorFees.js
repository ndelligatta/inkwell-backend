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
// Prefer IPv4 to avoid IPv6 egress issues on some hosts
try {
  const dns = require('node:dns');
  if (dns && typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (_) {}

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
// Align RPC usage with server.js: strict Helius-only connection with validation
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null;
const FALLBACK_RPC_URL = (process.env.FALLBACK_RPC_URL || '').trim();
function isValidHttpUrl(u) { return /^https?:\/\//.test(u); }
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds

// Create a Helius connection and verify it's responsive
async function getHeliusConnectionOrThrow() {
  if (!HELIUS_RPC) throw new Error('HELIUS_API_KEY not configured');
  const connection = new Connection(HELIUS_RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60000 });
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      await connection.getLatestBlockhash('confirmed');
      return connection;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(`Helius RPC unavailable: ${lastErr?.message || lastErr}`);
}

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
      // For known migrated pools, use hardcoded mint addresses
      // This is temporary until we can decode migration metadata
      const knownMigratedPools = {
        'FwRuQKaoJdqcE4JXpfav9xR4a4XnPvdBCr3NrZNP1ELF': {
          baseMint: new PublicKey('FbCk2TgjKkSR3F63C2SuBtKvN7bLdYCz5tHFGDFPPRtY'),
          quoteMint: new PublicKey('So11111111111111111111111111111111111111112') // SOL
        }
      };
      
      let baseMint, quoteMint;
      
      // Check if this is a known migrated pool
      if (knownMigratedPools[poolAddress]) {
        console.log('Using known mint addresses for migrated pool');
        baseMint = knownMigratedPools[poolAddress].baseMint;
        quoteMint = knownMigratedPools[poolAddress].quoteMint;
      } else {
        // Try to get pool state (this might fail if already migrated)
        const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
        let poolState;
        
        try {
          poolState = await dbcClient.state.getPool(poolPubkey);
          if (!poolState || !poolState.baseMint || !poolState.quoteMint) {
            throw new Error('Invalid pool state - missing token mints');
          }
          baseMint = poolState.baseMint;
          quoteMint = poolState.quoteMint;
        } catch (error) {
          console.error('Failed to get pool state:', error.message);
          
          // Try to get from database if available
          if (supabase) {
            const { data: poolData } = await supabase
              .from('token_pools')
              .select('token_mint')
              .eq('pool_address', poolAddress)
              .single();
              
            if (poolData && poolData.token_mint) {
              baseMint = new PublicKey(poolData.token_mint);
              quoteMint = new PublicKey('So11111111111111111111111111111111111111112'); // SOL
              console.log('Got token mint from database:', baseMint.toString());
            } else {
              throw new Error('Cannot determine token mints for migrated pool');
            }
          } else {
            throw new Error('Cannot retrieve token mints from migrated pool');
          }
        }
      }
      
      // Try each DAMM v2 config to find the migrated pool
      for (let i = 0; i < DAMM_V2_MIGRATION_FEE_ADDRESS.length; i++) {
        const config = DAMM_V2_MIGRATION_FEE_ADDRESS[i];
        
        // Use the official derivation function
        const migratedPoolAddress = deriveDammV2PoolAddress(
          config,
          baseMint,
          quoteMint
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

// Prepare an unsigned claim transaction for DBC (non-migrated) using the user's wallet (Privy)
async function prepareCreatorClaimTxDBC({ connection, dbcClient, poolPubkey, userWalletPubkey, feeMetrics }) {
  const claimTx = await dbcClient.creator.claimCreatorTradingFee({
    creator: userWalletPubkey,
    pool: poolPubkey,
    maxBaseAmount: feeMetrics.current.creatorBaseFee,
    maxQuoteAmount: feeMetrics.current.creatorQuoteFee,
    payer: userWalletPubkey,
  });
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  claimTx.feePayer = userWalletPubkey;
  claimTx.recentBlockhash = blockhash;
  return claimTx;
}

// Prepare unsigned claim transactions for DAMM v2 positions using the user's wallet (Privy)
async function prepareCreatorClaimTxDammV2({ connection, migratedPoolAddress, userWalletPubkey }) {
  const cpAmm = new CpAmm(connection);
  const poolPubkey = new PublicKey(migratedPoolAddress);
  const poolState = await cpAmm.fetchPoolState(poolPubkey);
  const userPositions = await cpAmm.getUserPositionByPool(poolPubkey, userWalletPubkey);
  if (!userPositions || userPositions.length === 0) {
    return [];
  }
  function getTokenProgram(tokenFlag) {
    return tokenFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  }
  const txs = [];
  for (const position of userPositions) {
    const claimTx = await cpAmm.claimPositionFee2({
      receiver: userWalletPubkey,
      owner: userWalletPubkey,
      pool: poolPubkey,
      position: position.position,
      positionNftAccount: position.positionNftAccount,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAProgram: getTokenProgram(poolState.tokenAFlag),
      tokenBProgram: getTokenProgram(poolState.tokenBFlag),
      feePayer: userWalletPubkey,
    });
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    claimTx.feePayer = userWalletPubkey;
    claimTx.recentBlockhash = blockhash;
    txs.push(claimTx);
  }
  return txs;
}

// Broadcast a signed transaction and log results (single tx)
async function broadcastSignedClaimTx({ connection, supabaseClient, poolAddress, userId, signedTxBase64 }) {
  const txBuffer = Buffer.from(signedTxBase64, 'base64');
  const { Transaction } = require('@solana/web3.js');
  const tx = Transaction.from(txBuffer);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(signature, 'confirmed');
  // Best-effort DB logging (no amount calculation here as fees now zero post-claim)
  if (supabaseClient) {
    try {
      const { data: post } = await supabaseClient
        .from('user_posts')
        .select('id')
        .eq('pool_address', poolAddress)
        .single();
      if (post) {
        await supabaseClient
          .from('post_fee_claim_history')
          .insert({
            post_id: post.id,
            pool_address: poolAddress,
            base_fees_claimed: 0,
            quote_fees_claimed: 0,
            sol_amount: 0,
            transaction_signature: signature,
            claimer_address: tx.feePayer?.toString() || null,
            success: true
          });
      }
    } catch (e) {
      // ignore logging errors
    }
  }
  return { signature };
}

// Claim fees from a single pool
async function claimCreatorFees(poolAddress, creatorPrivateKey, userId) {
  try {
    console.log('====== CLAIM CREATOR FEES START ======');
    console.log('Pool:', poolAddress);
    console.log('User ID:', userId);
    
    // Initialize Helius connection (single provider, validated)
    let connection;
    let dbcClient;
    try {
      console.log('Trying RPC: Helius endpoint...');
      connection = await getHeliusConnectionOrThrow();
      dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    } catch (error) {
      console.error('Failed to connect to Helius RPC:', error.message);
      // Optional, safe fallback if configured and valid
      if (isValidHttpUrl(FALLBACK_RPC_URL)) {
        try {
          console.log('Trying RPC: Fallback endpoint...');
          connection = new Connection(FALLBACK_RPC_URL, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60000 });
          await connection.getLatestBlockhash('confirmed');
          dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
          console.log('Connected via fallback RPC');
        } catch (fallbackErr) {
          console.error('Failed to connect to Fallback RPC:', fallbackErr.message);
          throw new Error(`All RPC endpoints failed: ${fallbackErr.message}`);
        }
      } else {
        throw error;
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
    
    // Helius-only connection
    let connection;
    let dbcClient;
    try {
      connection = await getHeliusConnectionOrThrow();
      dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    } catch (error) {
      if (isValidHttpUrl(FALLBACK_RPC_URL)) {
        try {
          connection = new Connection(FALLBACK_RPC_URL, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60000 });
          await connection.getLatestBlockhash('confirmed');
          dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
        } catch (fallbackErr) {
          return { success: false, error: `All RPC endpoints failed: ${fallbackErr.message}` };
        }
      } else {
        return { success: false, error: error.message || 'Helius RPC unavailable' };
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
  checkAvailableCreatorFees,
  prepareCreatorClaimTxDBC,
  prepareCreatorClaimTxDammV2,
  checkPoolMigrationOfficial,
  getMigratedPoolAddress,
  broadcastSignedClaimTx
};
