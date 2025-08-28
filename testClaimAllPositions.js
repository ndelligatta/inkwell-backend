// Test script to claim ALL fees from ALL positions in DAMM pool
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { 
  DynamicBondingCurveClient,
  deriveDammV2PoolAddress,
  DAMM_V2_MIGRATION_FEE_ADDRESS
} = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { CpAmm } = require('@meteora-ag/cp-amm-sdk');
// const { DLMM } = require('@meteora-ag/dlmm'); // Not needed for CP-AMM
const bs58 = require('bs58').default;
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

// Constants
const PRE_MIGRATION_POOL = "DMMkjnyCg89tYPYNZAcFXdt9djWCCbyQwWvvXg1cZuQR";
const TOKEN_MINT = "BZnmwStz8iapHZoM5YRbvf563qAShUvN28PJDDHvpRTy";
const CONFIG_ADDRESS = "4wGDGetHZYw6c6MJkiqz8LL5nHMnWvgLGTcF7dypSzGi";
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const ADMIN_PUBLIC_KEY = "KAQmut31iGrghKrnaaJbv7FS87ez6JYkDrVPgLDjXnk";

const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const QUOTE_MINT = "So11111111111111111111111111111111111111112"; // SOL

async function claimAllPoolFees() {
  try {
    console.log('====== CLAIM ALL POOL FEES TEST ======\n');
    
    if (!ADMIN_PRIVATE_KEY) {
      throw new Error('Missing ADMIN_PRIVATE_KEY environment variable');
    }

    // Initialize connection
    const connection = new Connection(RPC_URL, 'confirmed');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    
    // Create admin keypair
    const adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_PRIVATE_KEY));
    console.log('Admin wallet:', adminKeypair.publicKey.toString());
    
    // Check initial balance
    const initialBalance = await connection.getBalance(adminKeypair.publicKey);
    console.log('Initial admin balance:', (initialBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL\n');

    // Get pool config
    const configPubkey = new PublicKey(CONFIG_ADDRESS);
    let migrationFeeOption = 0;
    try {
      const poolConfigState = await dbcClient.state.getPoolConfig(configPubkey);
      migrationFeeOption = poolConfigState.migrationFeeOption || 0;
    } catch (error) {
      console.log('Using default migration fee option 0');
    }

    // Derive DAMM v2 pool address
    const baseMint = new PublicKey(TOKEN_MINT);
    const quoteMint = new PublicKey(QUOTE_MINT);
    const dammV2Config = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
    const dammV2PoolAddress = deriveDammV2PoolAddress(dammV2Config, baseMint, quoteMint);
    
    console.log('DAMM v2 Pool Address:', dammV2PoolAddress.toString());
    
    // Initialize CP AMM
    const cpAmm = new CpAmm(connection);
    
    // Get pool state
    console.log('\nFetching pool state...');
    const poolState = await cpAmm.fetchPoolState(dammV2PoolAddress);
    console.log('Pool state fetched successfully');
    
    // Log pool state details
    console.log('\n=== POOL STATE DETAILS ===');
    console.log('Token A Mint:', poolState.tokenAMint?.toString());
    console.log('Token B Mint:', poolState.tokenBMint?.toString());
    console.log('Token A Vault:', poolState.tokenAVault?.toString());
    console.log('Token B Vault:', poolState.tokenBVault?.toString());
    console.log('Protocol Fee Rate:', poolState.protocolFeeRate);
    console.log('Fund Fee Rate:', poolState.fundFeeRate);
    console.log('Config ID:', poolState.configId?.toString());
    console.log('Authority:', poolState.authority?.toString());
    
    // Method 1: Get ALL positions for the pool (not just user's positions)
    console.log('\n=== Method 1: Checking ALL pool positions ===');
    try {
      // Try to get pool positions through different methods
      const poolAccount = await connection.getAccountInfo(dammV2PoolAddress);
      console.log('Pool account size:', poolAccount?.data.length);
      
      // Check pool authority
      console.log('Pool authority:', poolState.authority?.toString());
      console.log('Pool config ID:', poolState.configId?.toString());
      
      // Get positions for admin
      const userPositions = await cpAmm.getUserPositionByPool(
        dammV2PoolAddress,
        adminKeypair.publicKey
      );
      console.log(`Admin has ${userPositions ? userPositions.length : 0} positions`);
      
    } catch (error) {
      console.log('Error checking pool positions:', error.message);
    }
    
    // Method 2: Check for multiple fee accounts
    console.log('\n=== Method 2: Checking pool fee structure ===');
    try {
      // Get token vault balances to see total fees
      const tokenABalance = await connection.getTokenAccountBalance(poolState.tokenAVault);
      const tokenBBalance = await connection.getTokenAccountBalance(poolState.tokenBVault);
      
      console.log('Token A Vault balance:', tokenABalance.value.uiAmount);
      console.log('Token B Vault balance:', tokenBBalance.value.uiAmount);
      
      // If token B is WSOL, that's where our SOL fees are
      if (poolState.tokenBMint.toString() === 'So11111111111111111111111111111111111111112') {
        console.log(`Total SOL in vault: ${tokenBBalance.value.uiAmount} SOL`);
      }
      
    } catch (error) {
      console.log('Error checking vault balances:', error.message);
    }
    
    // Method 3: Get all positions and claim individually
    console.log('\n=== Method 3: Individual position claims ===');
    const userPositions = await cpAmm.getUserPositionByPool(
      dammV2PoolAddress,
      adminKeypair.publicKey
    );
    
    if (userPositions && userPositions.length > 0) {
      console.log(`Found ${userPositions.length} positions to claim from`);
      
      let successCount = 0;
      for (let i = 0; i < userPositions.length; i++) {
        const position = userPositions[i];
        console.log(`\nClaiming from position ${i+1}/${userPositions.length}:`, position.position?.toString());
        
        try {
          // Check if position has fees to claim
          console.log('Position NFT:', position.positionNftAccount?.toString());
          
          // Create claim transaction
          const claimPositionFeesTx = await cpAmm.claimPositionFee2({
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

          claimPositionFeesTx.feePayer = adminKeypair.publicKey;
          const { blockhash } = await connection.getLatestBlockhash('confirmed');
          claimPositionFeesTx.recentBlockhash = blockhash;
          claimPositionFeesTx.sign(adminKeypair);
          
          // First simulate the transaction
          console.log('Simulating transaction...');
          const simulation = await connection.simulateTransaction(claimPositionFeesTx);
          
          if (simulation.value.err) {
            console.error('\n❌ SIMULATION FAILED!');
            console.error('Error:', JSON.stringify(simulation.value.err, null, 2));
            console.error('\nTransaction logs:');
            if (simulation.value.logs) {
              simulation.value.logs.forEach((log, idx) => {
                console.error(`  ${idx}: ${log}`);
              });
            }
            continue;
          }
          
          console.log('✅ Simulation successful');
          console.log('Transaction logs:');
          if (simulation.value.logs) {
            simulation.value.logs.forEach((log, idx) => {
              console.log(`  ${idx}: ${log}`);
            });
          }
          
          // Send transaction
          const signature = await connection.sendRawTransaction(
            claimPositionFeesTx.serialize(),
            {
              skipPreflight: false,
              preflightCommitment: 'confirmed'
            }
          );
          
          console.log('Transaction sent:', signature);
          await connection.confirmTransaction(signature, 'confirmed');
          console.log('✅ Claimed successfully!');
          
          successCount++;
          
          // Check balance after each claim
          const currentBalance = await connection.getBalance(adminKeypair.publicKey);
          const claimedSoFar = (currentBalance - initialBalance) / LAMPORTS_PER_SOL;
          console.log(`Claimed so far: ${claimedSoFar.toFixed(6)} SOL`);
          
        } catch (positionError) {
          console.error('\n❌ POSITION CLAIM ERROR!');
          console.error('Error Type:', positionError.constructor.name);
          console.error('Error Message:', positionError.message);
          
          // Try to get logs from SendTransactionError
          if (positionError.logs) {
            console.error('\nError logs:');
            positionError.logs.forEach((log, idx) => {
              console.error(`  ${idx}: ${log}`);
            });
          }
          
          // If it's a SendTransactionError, try getLogs()
          if (typeof positionError.getLogs === 'function') {
            try {
              const logs = positionError.getLogs();
              console.error('\nDetailed logs from getLogs():');
              logs.forEach((log, idx) => {
                console.error(`  ${idx}: ${log}`);
              });
            } catch (e) {
              console.error('Could not get logs:', e.message);
            }
          }
          
          console.error('\nFull error object:');
          console.error(JSON.stringify(positionError, null, 2));
          console.error('\nStack trace:');
          console.error(positionError.stack);
        }
      }
      
      console.log(`\nSuccessfully claimed from ${successCount}/${userPositions.length} positions`);
    }
    
    // Method 4: Try to claim protocol fees if admin is authority
    console.log('\n=== Method 4: Protocol fee claim ===');
    if (poolState.authority?.toString() === adminKeypair.publicKey.toString()) {
      console.log('Admin is pool authority - attempting protocol fee claim...');
      try {
        const claimProtocolFeeTx = await cpAmm.claimProtocolFee({
          owner: adminKeypair.publicKey,
          authority: adminKeypair.publicKey,
          pool: dammV2PoolAddress,
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
        
        const signature = await connection.sendRawTransaction(claimProtocolFeeTx.serialize());
        console.log('Protocol fee claim sent:', signature);
        await connection.confirmTransaction(signature, 'confirmed');
        console.log('✅ Protocol fees claimed!');
      } catch (error) {
        console.error('Protocol fee claim failed:', error.message);
      }
    } else {
      console.log('Admin is not pool authority');
    }
    
    // Final results
    const finalBalance = await connection.getBalance(adminKeypair.publicKey);
    const totalClaimed = (finalBalance - initialBalance) / LAMPORTS_PER_SOL;
    
    console.log('\n====== FINAL RESULTS ======');
    console.log('Initial balance:', (initialBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Final balance:', (finalBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Total claimed:', totalClaimed.toFixed(6), 'SOL');
    console.log('Total claimed USD:', `$${(totalClaimed * 204).toFixed(2)}`); // Assuming SOL = $204

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the test
console.log('Starting claim all positions test...\n');
claimAllPoolFees();