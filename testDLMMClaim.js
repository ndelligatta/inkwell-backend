// Test script to find and claim from ALL DLMM positions/bins
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { DLMM } = require('@meteora-ag/dlmm');
const { 
  DynamicBondingCurveClient,
  deriveDammV2PoolAddress,
  DAMM_V2_MIGRATION_FEE_ADDRESS
} = require('@meteora-ag/dynamic-bonding-curve-sdk');
const bs58 = require('bs58').default;

// Constants
const TOKEN_MINT = "BZnmwStz8iapHZoM5YRbvf563qAShUvN28PJDDHvpRTy";
const CONFIG_ADDRESS = "4wGDGetHZYw6c6MJkiqz8LL5nHMnWvgLGTcF7dypSzGi";
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const ADMIN_PUBLIC_KEY = "KAQmut31iGrghKrnaaJbv7FS87ez6JYkDrVPgLDjXnk";

const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const QUOTE_MINT = "So11111111111111111111111111111111111111112"; // SOL

// Known DLMM pools from Solscan
const KNOWN_DLMM_POOL = new PublicKey('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC');

async function claimAllDLMMFees() {
  try {
    console.log('====== DLMM FEE CLAIM TEST ======\n');
    
    if (!ADMIN_PRIVATE_KEY) {
      throw new Error('Missing ADMIN_PRIVATE_KEY environment variable');
    }

    // Initialize connection
    const connection = new Connection(RPC_URL, 'confirmed');
    
    // Create admin keypair
    const adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_PRIVATE_KEY));
    console.log('Admin wallet:', adminKeypair.publicKey.toString());
    
    // Check initial balance
    const initialBalance = await connection.getBalance(adminKeypair.publicKey);
    console.log('Initial admin balance:', (initialBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL\n');

    // Initialize DLMM client
    const dlmmClient = new DLMM(connection);
    
    console.log('=== STEP 1: Finding DLMM Pool ===');
    
    // First, check if the known pool is a DLMM pool
    console.log('Checking known pool:', KNOWN_DLMM_POOL.toString());
    
    try {
      // Try to get the DLMM pool
      const dlmmPool = await DLMM.create(connection, KNOWN_DLMM_POOL);
      console.log('✅ Found DLMM pool!');
      
      // Get pool info
      const poolInfo = dlmmPool.poolInfo;
      console.log('\nPool Info:');
      console.log('Token X:', poolInfo.tokenXMint?.toString());
      console.log('Token Y:', poolInfo.tokenYMint?.toString());
      console.log('Active Bin:', poolInfo.activeBin);
      console.log('Bin Step:', poolInfo.binStep);
      
      console.log('\n=== STEP 2: Finding User Positions ===');
      
      // Get all positions for this pool and user
      const positions = await dlmmPool.getPositionsByUserAndLbPair(adminKeypair.publicKey);
      console.log(`Found ${positions.userPositions.length} positions/bins`);
      
      if (positions.userPositions.length === 0) {
        console.log('No positions found for admin wallet');
        
        // Try to find all positions in the pool
        console.log('\nTrying to find all positions in the pool...');
        const allBinArrays = await dlmmPool.getBinArrays();
        console.log(`Pool has ${allBinArrays.length} bin arrays`);
        
      } else {
        console.log('\n=== STEP 3: Checking Unclaimed Fees ===');
        
        // Check unclaimed fees for each position
        let totalUnclaimedX = 0;
        let totalUnclaimedY = 0;
        
        for (let i = 0; i < positions.userPositions.length; i++) {
          const position = positions.userPositions[i];
          console.log(`\nPosition ${i+1}/${positions.userPositions.length}:`);
          console.log('Position Key:', position.publicKey.toString());
          console.log('Lower Bin:', position.positionData.lowerBinId);
          console.log('Upper Bin:', position.positionData.upperBinId);
          
          // Get unclaimed fees
          try {
            const fees = await dlmmPool.getUnclaimedSwapFee(position.positionData);
            console.log('Unclaimed Token X:', fees.feeX.toString());
            console.log('Unclaimed Token Y:', fees.feeY.toString());
            
            totalUnclaimedX += Number(fees.feeX);
            totalUnclaimedY += Number(fees.feeY);
          } catch (e) {
            console.log('Could not get unclaimed fees:', e.message);
          }
        }
        
        console.log('\nTotal Unclaimed Fees:');
        console.log('Token X:', totalUnclaimedX);
        console.log('Token Y:', totalUnclaimedY);
        
        if (poolInfo.tokenYMint?.toString() === QUOTE_MINT) {
          console.log('Total SOL to claim:', (totalUnclaimedY / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
        }
        
        console.log('\n=== STEP 4: Claiming All Fees ===');
        
        // Method 1: Try claimAllSwapFee
        try {
          console.log('\nAttempting claimAllSwapFee...');
          const claimAllTxs = await dlmmPool.claimAllSwapFee({
            owner: adminKeypair.publicKey,
            positions: positions.userPositions
          });
          
          console.log(`Generated ${claimAllTxs.length} claim transactions`);
          
          for (let i = 0; i < claimAllTxs.length; i++) {
            const tx = claimAllTxs[i];
            tx.feePayer = adminKeypair.publicKey;
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.sign(adminKeypair);
            
            console.log(`\nSending transaction ${i+1}/${claimAllTxs.length}...`);
            const signature = await connection.sendRawTransaction(tx.serialize());
            console.log('Signature:', signature);
            
            await connection.confirmTransaction(signature, 'confirmed');
            console.log('✅ Confirmed!');
          }
          
        } catch (error) {
          console.error('claimAllSwapFee failed:', error.message);
          
          // Method 2: Try claimAllRewards
          try {
            console.log('\nAttempting claimAllRewards...');
            const claimAllTxs = await dlmmPool.claimAllRewards({
              owner: adminKeypair.publicKey,
              positions: positions.userPositions
            });
            
            console.log(`Generated ${claimAllTxs.length} claim transactions`);
            
            for (let i = 0; i < claimAllTxs.length; i++) {
              const tx = claimAllTxs[i];
              tx.feePayer = adminKeypair.publicKey;
              const { blockhash } = await connection.getLatestBlockhash('confirmed');
              tx.recentBlockhash = blockhash;
              tx.sign(adminKeypair);
              
              console.log(`\nSending transaction ${i+1}/${claimAllTxs.length}...`);
              const signature = await connection.sendRawTransaction(tx.serialize());
              console.log('Signature:', signature);
              
              await connection.confirmTransaction(signature, 'confirmed');
              console.log('✅ Confirmed!');
            }
            
          } catch (error2) {
            console.error('claimAllRewards also failed:', error2.message);
            
            // Method 3: Claim individually
            console.log('\nTrying individual position claims...');
            for (let i = 0; i < positions.userPositions.length; i++) {
              const position = positions.userPositions[i];
              try {
                console.log(`\nClaiming position ${i+1}/${positions.userPositions.length}...`);
                const claimTx = await dlmmPool.claimSwapFee({
                  owner: adminKeypair.publicKey,
                  position: position.publicKey
                });
                
                claimTx.feePayer = adminKeypair.publicKey;
                const { blockhash } = await connection.getLatestBlockhash('confirmed');
                claimTx.recentBlockhash = blockhash;
                claimTx.sign(adminKeypair);
                
                const signature = await connection.sendRawTransaction(claimTx.serialize());
                console.log('Signature:', signature);
                await connection.confirmTransaction(signature, 'confirmed');
                console.log('✅ Claimed!');
                
              } catch (posError) {
                console.error(`Failed to claim position ${i+1}:`, posError.message);
              }
            }
          }
        }
      }
      
    } catch (dlmmError) {
      console.log('Not a DLMM pool or error:', dlmmError.message);
      
      // Check if it's the DAMM v2 pool instead
      console.log('\nChecking if this is the DAMM v2 pool...');
      const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
      
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
      
      // Try DLMM on the DAMM pool
      console.log('\nTrying DLMM methods on DAMM v2 pool...');
      try {
        const dlmmPool2 = await DLMM.create(connection, dammV2PoolAddress);
        console.log('✅ DAMM v2 pool supports DLMM interface!');
        
        // Get positions
        const positions2 = await dlmmPool2.getPositionsByUserAndLbPair(adminKeypair.publicKey);
        console.log(`Found ${positions2.userPositions.length} DLMM positions in DAMM pool`);
        
        // Try to claim
        if (positions2.userPositions.length > 0) {
          const claimTxs = await dlmmPool2.claimAllSwapFee({
            owner: adminKeypair.publicKey,
            positions: positions2.userPositions
          });
          
          for (const tx of claimTxs) {
            tx.feePayer = adminKeypair.publicKey;
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            tx.recentBlockhash = blockhash;
            tx.sign(adminKeypair);
            
            const signature = await connection.sendRawTransaction(tx.serialize());
            console.log('Claimed from DAMM position:', signature);
            await connection.confirmTransaction(signature, 'confirmed');
          }
        }
      } catch (e) {
        console.log('DAMM v2 pool does not support DLMM interface:', e.message);
      }
    }
    
    // Final results
    const finalBalance = await connection.getBalance(adminKeypair.publicKey);
    const totalClaimed = (finalBalance - initialBalance) / LAMPORTS_PER_SOL;
    
    console.log('\n====== FINAL RESULTS ======');
    console.log('Initial balance:', (initialBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Final balance:', (finalBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Total claimed:', totalClaimed.toFixed(6), 'SOL');
    console.log('Total claimed USD:', `$${(totalClaimed * 204).toFixed(2)}`);

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the test
console.log('Starting DLMM fee claim test...\n');
claimAllDLMMFees();