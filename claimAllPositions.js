// Script to find and claim from ALL positions in the DAMM v2 pool
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { 
  DynamicBondingCurveClient,
  deriveDammV2PoolAddress,
  DAMM_V2_MIGRATION_FEE_ADDRESS
} = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { CpAmm } = require('@meteora-ag/cp-amm-sdk');
const bs58 = require('bs58').default;
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

// Constants
const TOKEN_MINT = "BZnmwStz8iapHZoM5YRbvf563qAShUvN28PJDDHvpRTy";
const CONFIG_ADDRESS = "FpBnATp3c4i3sVo35u6zyZVpnUEDE6RmVsEofEK1YAMU";
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const ADMIN_PUBLIC_KEY = "KAQmut31iGrghKrnaaJbv7FS87ez6JYkDrVPgLDjXnk";

const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const QUOTE_MINT = "So11111111111111111111111111111111111111112"; // SOL

async function claimAllPositions() {
  try {
    console.log('====== CLAIM ALL POSITIONS FROM DAMM V2 POOL ======\n');
    
    if (!ADMIN_PRIVATE_KEY) {
      throw new Error('Missing ADMIN_PRIVATE_KEY environment variable');
    }

    // Initialize connection
    const connection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000
    });
    
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    const adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_PRIVATE_KEY));
    
    console.log('Admin wallet:', adminKeypair.publicKey.toString());
    
    const initialBalance = await connection.getBalance(adminKeypair.publicKey);
    console.log('Initial balance:', (initialBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL\n');

    // Step 1: Derive the correct DAMM v2 pool address
    console.log('Step 1: Deriving DAMM v2 pool address...');
    const configPubkey = new PublicKey(CONFIG_ADDRESS);
    let migrationFeeOption = 0;
    
    try {
      const poolConfigState = await dbcClient.state.getPoolConfig(configPubkey);
      migrationFeeOption = poolConfigState.migrationFeeOption || 0;
    } catch (error) {
      console.log('Using default migration fee option 0');
    }

    const baseMint = new PublicKey(TOKEN_MINT);
    const quoteMint = new PublicKey(QUOTE_MINT);
    const dammV2Config = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
    const dammV2PoolAddress = deriveDammV2PoolAddress(dammV2Config, baseMint, quoteMint);
    
    console.log('DAMM v2 Pool Address:', dammV2PoolAddress.toString());

    // Step 2: Initialize CP-AMM and get pool state
    console.log('\nStep 2: Fetching pool state...');
    const cpAmm = new CpAmm(connection);
    const poolState = await cpAmm.fetchPoolState(dammV2PoolAddress);
    console.log('Pool state fetched successfully');
    console.log('Token B Vault (SOL):', poolState.tokenBVault.toString());

    // Step 3: Get ALL positions for the user
    console.log('\nStep 3: Finding ALL user positions...');
    const userPositions = await cpAmm.getUserPositionByPool(
      dammV2PoolAddress,
      adminKeypair.publicKey
    );
    
    console.log(`Found ${userPositions.length} positions for admin wallet`);
    
    if (userPositions.length === 0) {
      console.log('\n❌ No positions found! Checking for other position discovery methods...');
      
      // Try alternative method to find positions
      console.log('\nTrying to get all positions by user...');
      try {
        // Some SDKs have a getPositionsByUser method
        const allUserPositions = await cpAmm.getUserPositions(adminKeypair.publicKey);
        console.log(`Found ${allUserPositions.length} total positions across all pools`);
        
        // Filter for our pool
        const poolPositions = allUserPositions.filter(pos => 
          pos.pool?.equals(dammV2PoolAddress)
        );
        console.log(`Found ${poolPositions.length} positions for our pool`);
        
        if (poolPositions.length > 0) {
          userPositions.push(...poolPositions);
        }
      } catch (e) {
        console.log('getPositionsByUser not available:', e.message);
      }
    }

    // Step 4: Display position details
    console.log('\nStep 4: Position details:');
    for (let i = 0; i < userPositions.length; i++) {
      const position = userPositions[i];
      console.log(`\nPosition ${i+1}/${userPositions.length}:`);
      console.log('  Address:', position.position?.toString());
      console.log('  NFT:', position.positionNftAccount?.toString());
      
      // Try to get position state for more details
      try {
        const positionState = await cpAmm.getPosition(position.position);
        if (positionState) {
          console.log('  Liquidity:', positionState.liquidity?.toString());
          console.log('  Fee Owner:', positionState.feeOwner?.toString());
        }
      } catch (e) {
        // Position state not available
      }
    }

    // Step 5: Claim from each position
    console.log('\nStep 5: Claiming fees from each position...');
    
    let successCount = 0;
    let totalClaimedEstimate = 0;
    const claimedPositions = [];
    const failedPositions = [];

    for (let i = 0; i < userPositions.length; i++) {
      const position = userPositions[i];
      console.log(`\n--- Claiming position ${i+1}/${userPositions.length} ---`);
      console.log('Position:', position.position?.toString());
      
      try {
        // Create claim transaction
        const claimTx = await cpAmm.claimPositionFee2({
          receiver: adminKeypair.publicKey,
          owner: adminKeypair.publicKey,
          pool: dammV2PoolAddress,
          position: position.position,
          positionNftAccount: position.positionNftAccount,
          tokenAVault: poolState.tokenAVault,
          tokenBVault: poolState.tokenBVault,
          tokenAMint: poolState.tokenAMint,
          tokenBMint: poolState.tokenBMint,
          tokenAProgram: poolState.tokenAFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
          tokenBProgram: poolState.tokenBFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
          feePayer: adminKeypair.publicKey,
        });

        // Set transaction details
        claimTx.feePayer = adminKeypair.publicKey;
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        claimTx.recentBlockhash = blockhash;
        
        // Sign transaction
        claimTx.sign(adminKeypair);
        
        // First simulate to check for errors
        console.log('Simulating transaction...');
        const simulation = await connection.simulateTransaction(claimTx, {
          sigVerify: false,
          commitment: 'confirmed'
        });
        
        if (simulation.value.err) {
          console.error('❌ Simulation failed!');
          console.error('Error:', JSON.stringify(simulation.value.err, null, 2));
          if (simulation.value.logs) {
            console.error('Logs:');
            simulation.value.logs.forEach((log, idx) => {
              console.error(`  ${idx}: ${log}`);
            });
          }
          failedPositions.push({
            position: position.position.toString(),
            error: simulation.value.err
          });
          continue;
        }
        
        console.log('✅ Simulation successful');
        
        // Send transaction
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
        
        console.log('✅ Claimed successfully!');
        console.log('View on Solscan:', `https://solscan.io/tx/${signature}`);
        
        // Check balance change
        const currentBalance = await connection.getBalance(adminKeypair.publicKey);
        const claimedThisPosition = (currentBalance - initialBalance - totalClaimedEstimate) / LAMPORTS_PER_SOL;
        totalClaimedEstimate = currentBalance - initialBalance;
        
        console.log(`Claimed from this position: ${claimedThisPosition.toFixed(6)} SOL`);
        console.log(`Total claimed so far: ${(totalClaimedEstimate / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
        
        claimedPositions.push({
          position: position.position.toString(),
          signature,
          claimedAmount: claimedThisPosition
        });
        
        successCount++;
        
        // Small delay between claims
        if (i < userPositions.length - 1) {
          console.log('Waiting 2 seconds before next claim...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
      } catch (error) {
        console.error('\n❌ CLAIM FAILED!');
        console.error('Error:', error.message);
        
        if (error.logs) {
          console.error('\nTransaction logs:');
          error.logs.forEach((log, idx) => {
            console.error(`  ${idx}: ${log}`);
          });
        }
        
        failedPositions.push({
          position: position.position.toString(),
          error: error.message
        });
      }
    }

    // Step 6: Final results
    const finalBalance = await connection.getBalance(adminKeypair.publicKey);
    const totalClaimed = (finalBalance - initialBalance) / LAMPORTS_PER_SOL;
    
    console.log('\n====== FINAL RESULTS ======');
    console.log('Positions processed:', userPositions.length);
    console.log('Successful claims:', successCount);
    console.log('Failed claims:', failedPositions.length);
    console.log('\nInitial balance:', (initialBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Final balance:', (finalBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Total claimed:', totalClaimed.toFixed(6), 'SOL');
    console.log('Total claimed USD:', `$${(totalClaimed * 204).toFixed(2)}`);
    
    if (claimedPositions.length > 0) {
      console.log('\n✅ Successfully claimed positions:');
      claimedPositions.forEach((pos, idx) => {
        console.log(`${idx + 1}. Position ${pos.position.substring(0, 8)}... claimed ${pos.claimedAmount.toFixed(6)} SOL`);
        console.log(`   https://solscan.io/tx/${pos.signature}`);
      });
    }
    
    if (failedPositions.length > 0) {
      console.log('\n❌ Failed positions:');
      failedPositions.forEach((pos, idx) => {
        console.log(`${idx + 1}. Position ${pos.position.substring(0, 8)}... Error: ${pos.error}`);
      });
    }

  } catch (error) {
    console.error('\n❌ MAIN ERROR:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the script
console.log('Starting claim all positions script...\n');
claimAllPositions();