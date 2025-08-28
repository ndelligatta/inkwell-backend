// Direct test to find pool and claim fees
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { 
  DynamicBondingCurveClient,
  deriveDammV1PoolAddress,
  deriveDammV2PoolAddress,
  DAMM_V1_MIGRATION_FEE_ADDRESS,
  DAMM_V2_MIGRATION_FEE_ADDRESS
} = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { CpAmm } = require('@meteora-ag/cp-amm-sdk');
const bs58 = require('bs58').default;

// Constants
const PRE_MIGRATION_POOL = "DMMkjnyCg89tYPYNZAcFXdt9djWCCbyQwWvvXg1cZuQR";
const TOKEN_MINT = "BZnmwStz8iapHZoM5YRbvf563qAShUvN28PJDDHvpRTy";
const CONFIG_ADDRESS = "FpBnATp3c4i3sVo35u6zyZVpnUEDE6RmVsEofEK1YAMU";
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const ADMIN_PUBLIC_KEY = "KAQmut31iGrghKrnaaJbv7FS87ez6JYkDrVPgLDjXnk";

const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// SOL mint
const QUOTE_MINT = "So11111111111111111111111111111111111111112";

async function testDirectClaim() {
  try {
    console.log('====== DIRECT POOL FIND AND CLAIM TEST ======\n');
    
    if (!ADMIN_PRIVATE_KEY) {
      throw new Error('Missing ADMIN_PRIVATE_KEY environment variable');
    }

    // Initialize connection
    const connection = new Connection(RPC_URL, 'confirmed');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    
    // Create admin keypair
    const adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_PRIVATE_KEY));
    console.log('Admin wallet:', adminKeypair.publicKey.toString());
    
    if (adminKeypair.publicKey.toString() !== ADMIN_PUBLIC_KEY) {
      throw new Error(`Admin wallet mismatch! Expected ${ADMIN_PUBLIC_KEY}`);
    }

    // Check admin balance
    const balance = await connection.getBalance(adminKeypair.publicKey);
    console.log('Admin balance:', (balance / LAMPORTS_PER_SOL).toFixed(6), 'SOL\n');

    // Step 1: Get the config to determine migration fee option
    console.log('Step 1: Fetching pool config...');
    const configPubkey = new PublicKey(CONFIG_ADDRESS);
    let migrationFeeOption = 0;
    
    try {
      const poolConfigState = await dbcClient.state.getPoolConfig(configPubkey);
      migrationFeeOption = poolConfigState.migrationFeeOption || 0;
      console.log('Migration Fee Option:', migrationFeeOption);
    } catch (error) {
      console.log('Could not fetch config, using default migration fee option 0');
    }

    // Step 2: Derive the DAMM pool addresses
    console.log('\nStep 2: Deriving DAMM pool addresses...');
    const baseMint = new PublicKey(TOKEN_MINT);
    const quoteMint = new PublicKey(QUOTE_MINT);
    
    const dammV1Config = DAMM_V1_MIGRATION_FEE_ADDRESS[migrationFeeOption];
    const dammV2Config = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
    
    const dammV1PoolAddress = deriveDammV1PoolAddress(dammV1Config, baseMint, quoteMint);
    const dammV2PoolAddress = deriveDammV2PoolAddress(dammV2Config, baseMint, quoteMint);
    
    console.log('DAMM v1 Pool Address:', dammV1PoolAddress.toString());
    console.log('DAMM v2 Pool Address:', dammV2PoolAddress.toString());

    // Step 3: Check which pool exists
    console.log('\nStep 3: Checking which pool exists...');
    let actualPoolAddress = null;
    let poolVersion = null;
    
    // Check v2 first
    const v2Account = await connection.getAccountInfo(dammV2PoolAddress);
    if (v2Account) {
      console.log('✅ DAMM v2 pool EXISTS!');
      actualPoolAddress = dammV2PoolAddress;
      poolVersion = 'v2';
    } else {
      console.log('❌ DAMM v2 pool does not exist');
      
      // Check v1
      const v1Account = await connection.getAccountInfo(dammV1PoolAddress);
      if (v1Account) {
        console.log('✅ DAMM v1 pool EXISTS!');
        actualPoolAddress = dammV1PoolAddress;
        poolVersion = 'v1';
      } else {
        console.log('❌ DAMM v1 pool does not exist');
      }
    }

    if (!actualPoolAddress) {
      throw new Error('No DAMM pool found for this token');
    }

    console.log(`\nFound ${poolVersion} pool at: ${actualPoolAddress.toString()}`);

    // Step 4: Try to claim fees from DAMM v2 pool
    if (poolVersion === 'v2') {
      console.log('\nStep 4: Attempting to claim fees from DAMM v2 pool...');
      
      const cpAmm = new CpAmm(connection);
      
      // Get pool state
      console.log('Fetching pool state...');
      const poolState = await cpAmm.fetchPoolState(actualPoolAddress);
      console.log('Pool state fetched successfully');
      
      // Find positions
      console.log('\nFinding positions for admin wallet...');
      const userPositions = await cpAmm.getUserPositionByPool(
        actualPoolAddress,
        adminKeypair.publicKey
      );
      
      console.log(`Found ${userPositions ? userPositions.length : 0} positions`);
      
      if (!userPositions || userPositions.length === 0) {
        console.log('\nNo positions found - checking if there are protocol fees to claim...');
        
        // Try to claim protocol fees
        try {
          const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
          
          const claimProtocolFeeTx = await cpAmm.claimProtocolFee({
            owner: adminKeypair.publicKey,
            authority: adminKeypair.publicKey,
            pool: actualPoolAddress,
            tokenAVault: poolState.tokenAVault,
            tokenBVault: poolState.tokenBVault,
            tokenAMint: poolState.tokenAMint,
            tokenBMint: poolState.tokenBMint,
            tokenAProgram: poolState.tokenAFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
            tokenBProgram: poolState.tokenBFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
          });

          claimProtocolFeeTx.feePayer = adminKeypair.publicKey;
          const { blockhash } = await connection.getLatestBlockhash('confirmed');
          claimProtocolFeeTx.recentBlockhash = blockhash;
          claimProtocolFeeTx.sign(adminKeypair);
          
          console.log('Sending protocol fee claim transaction...');
          const signature = await connection.sendRawTransaction(
            claimProtocolFeeTx.serialize(),
            {
              skipPreflight: false,
              preflightCommitment: 'confirmed'
            }
          );
          
          console.log('Transaction sent:', signature);
          console.log('Waiting for confirmation...');
          
          await connection.confirmTransaction(signature, 'confirmed');
          
          console.log('✅ Protocol fees claimed!');
          console.log('View on Solscan:', `https://solscan.io/tx/${signature}`);
          
        } catch (protocolError) {
          console.error('Protocol fee claim failed:', protocolError.message);
          
          // Check if it's a partner pool and try partner fee claim
          console.log('\nTrying partner fee claim...');
          try {
            // Partner pools might have different claim mechanism
            console.log('Pool config ID:', poolState.configId?.toString());
            console.log('Pool authority:', poolState.authority?.toString());
            
            // If the authority matches our admin, we might be able to claim
            if (poolState.authority?.toString() === adminKeypair.publicKey.toString()) {
              console.log('Admin is the pool authority - should be able to claim fees');
            } else {
              console.log('Admin is NOT the pool authority');
            }
            
          } catch (partnerError) {
            console.error('Partner fee check error:', partnerError.message);
          }
        }
      } else {
        // Try to claim from positions
        for (let i = 0; i < userPositions.length; i++) {
          const position = userPositions[i];
          console.log(`\nTrying to claim from position ${i+1}/${userPositions.length}:`, position.position?.toString());
          
          try {
            const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
            
            // Create claim transaction
            const claimPositionFeesTx = await cpAmm.claimPositionFee2({
              receiver: adminKeypair.publicKey,
              owner: adminKeypair.publicKey,
              pool: actualPoolAddress,
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

            // Set fee payer and blockhash
            claimPositionFeesTx.feePayer = adminKeypair.publicKey;
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            claimPositionFeesTx.recentBlockhash = blockhash;
            claimPositionFeesTx.sign(adminKeypair);
            
            // Simulate first
            console.log('Simulating transaction...');
            const simulation = await connection.simulateTransaction(claimPositionFeesTx);
            
            if (simulation.value.err) {
              console.error('Simulation failed:', simulation.value.err);
              console.log('Simulation logs:', simulation.value.logs);
              continue;
            }
            
            console.log('Simulation successful, sending transaction...');
            
            const signature = await connection.sendRawTransaction(
              claimPositionFeesTx.serialize(),
              {
                skipPreflight: false,
                preflightCommitment: 'confirmed'
              }
            );
            
            console.log('Transaction sent:', signature);
            console.log('Waiting for confirmation...');
            
            await connection.confirmTransaction(signature, 'confirmed');
            
            console.log('✅ Position fees claimed!');
            console.log('View on Solscan:', `https://solscan.io/tx/${signature}`);
            
          } catch (positionError) {
            console.error('Position claim failed:', positionError.message);
            if (positionError.logs) {
              console.log('Error logs:', positionError.logs);
            }
          }
        }
      }
    } else {
      console.log('\nDAMM v1 fee claiming not implemented in this test');
    }

    // Final balance check
    const finalBalance = await connection.getBalance(adminKeypair.publicKey);
    console.log('\nFinal admin balance:', (finalBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Balance change:', ((finalBalance - balance) / LAMPORTS_PER_SOL).toFixed(6), 'SOL');

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the test
console.log('Starting direct claim test...\n');
testDirectClaim();