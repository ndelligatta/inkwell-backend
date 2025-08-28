// Test to identify pool type and claim all fees with detailed error logging
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { CpAmm } = require('@meteora-ag/cp-amm-sdk');
const bs58 = require('bs58').default;
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount } = require('@solana/spl-token');

// Constants
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const ADMIN_PUBLIC_KEY = "KAQmut31iGrghKrnaaJbv7FS87ez6JYkDrVPgLDjXnk";
const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Pool addresses we found
const DAMM_V2_POOL = "5LU223t4zWhmC9duVkRdnnFJhvtHSHHsfCfNFz98i1Jg";
const SOLSCAN_POOL = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";
const TOKEN_B_VAULT = "6BhavFgfjt6maz1inPus9HCpRTGhYWRQpXqHigKeXm5a"; // Has 11.88 SOL

async function testPoolTypeAndClaim() {
  try {
    console.log('====== POOL TYPE IDENTIFICATION AND CLAIM TEST ======\n');
    
    if (!ADMIN_PRIVATE_KEY) {
      throw new Error('Missing ADMIN_PRIVATE_KEY environment variable');
    }

    const connection = new Connection(RPC_URL, 'confirmed');
    const adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_PRIVATE_KEY));
    console.log('Admin wallet:', adminKeypair.publicKey.toString());
    
    const initialBalance = await connection.getBalance(adminKeypair.publicKey);
    console.log('Initial balance:', (initialBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL\n');

    // Check both pools
    const pools = [
      { name: 'DAMM V2 Pool', address: DAMM_V2_POOL },
      { name: 'Solscan Pool', address: SOLSCAN_POOL }
    ];

    for (const pool of pools) {
      console.log(`\n=== Checking ${pool.name} ===`);
      console.log('Address:', pool.address);
      
      try {
        const poolPubkey = new PublicKey(pool.address);
        const accountInfo = await connection.getAccountInfo(poolPubkey);
        
        if (!accountInfo) {
          console.log('❌ Pool account not found');
          continue;
        }
        
        console.log('Owner Program:', accountInfo.owner.toString());
        console.log('Data size:', accountInfo.data.length);
        console.log('Executable:', accountInfo.executable);
        console.log('Lamports:', accountInfo.lamports);
        
        // Known Meteora program IDs
        const PROGRAMS = {
          'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': 'Meteora CP-AMM (DAMM v2)',
          'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
          'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Meteora Dynamic AMM',
          'CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW': 'Meteora CP-AMM v1',
          '11111111111111111111111111111111': 'System Program (not a pool)'
        };
        
        const programName = PROGRAMS[accountInfo.owner.toString()] || 'Unknown Program';
        console.log('Program Type:', programName);
        
        // If it's CP-AMM, try to get positions
        if (accountInfo.owner.toString() === 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG') {
          console.log('\n--- CP-AMM Pool Details ---');
          try {
            const cpAmm = new CpAmm(connection);
            const poolState = await cpAmm.fetchPoolState(poolPubkey);
            
            console.log('Token A:', poolState.tokenAMint?.toString());
            console.log('Token B:', poolState.tokenBMint?.toString());
            console.log('Token A Vault:', poolState.tokenAVault?.toString());
            console.log('Token B Vault:', poolState.tokenBVault?.toString());
            
            // Check vault balances
            try {
              const tokenABalance = await connection.getTokenAccountBalance(poolState.tokenAVault);
              const tokenBBalance = await connection.getTokenAccountBalance(poolState.tokenBVault);
              console.log('Token A Vault balance:', tokenABalance.value.uiAmount);
              console.log('Token B Vault balance:', tokenBBalance.value.uiAmount, 'SOL');
            } catch (vaultError) {
              console.log('Could not get vault balances:', vaultError.message);
            }
            
            // Get ALL positions by scanning for position accounts
            console.log('\n--- Finding ALL Pool Positions ---');
            
            // Method 1: Get user positions
            const userPositions = await cpAmm.getUserPositionByPool(poolPubkey, adminKeypair.publicKey);
            console.log(`Admin has ${userPositions.length} positions`);
            
            // Method 2: Try to find other positions in the pool
            console.log('\nSearching for other positions in the pool...');
            
            // Get all program accounts that might be positions
            const filters = [
              {
                dataSize: 2248 // Common size for position accounts
              }
            ];
            
            try {
              const programAccounts = await connection.getProgramAccounts(
                new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'),
                {
                  filters,
                  commitment: 'confirmed'
                }
              );
              
              console.log(`Found ${programAccounts.length} potential position accounts`);
              
              // Filter for positions related to our pool
              let poolPositions = 0;
              for (const account of programAccounts) {
                const data = account.account.data;
                // Check if this position is for our pool (pool address should be in the data)
                const poolAddressBytes = poolPubkey.toBuffer();
                if (data.includes(poolAddressBytes)) {
                  poolPositions++;
                }
              }
              console.log(`Found ${poolPositions} positions for this pool`);
              
            } catch (scanError) {
              console.error('Error scanning for positions:', scanError.message);
            }
            
            // Try to claim from each user position with detailed error logging
            if (userPositions.length > 0) {
              console.log('\n--- Attempting to claim from positions ---');
              
              for (let i = 0; i < userPositions.length; i++) {
                const position = userPositions[i];
                console.log(`\nPosition ${i+1}/${userPositions.length}:`);
                console.log('Position address:', position.position?.toString());
                console.log('Position NFT:', position.positionNftAccount?.toString());
                
                try {
                  // Check position details
                  const positionAccount = await connection.getAccountInfo(position.position);
                  if (positionAccount) {
                    console.log('Position account size:', positionAccount.data.length);
                    console.log('Position owner:', positionAccount.owner.toString());
                  }
                  
                  // Create claim transaction
                  const claimTx = await cpAmm.claimPositionFee2({
                    receiver: adminKeypair.publicKey,
                    owner: adminKeypair.publicKey,
                    pool: poolPubkey,
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
                  
                  claimTx.feePayer = adminKeypair.publicKey;
                  const { blockhash } = await connection.getLatestBlockhash('confirmed');
                  claimTx.recentBlockhash = blockhash;
                  claimTx.sign(adminKeypair);
                  
                  // Simulate with detailed logging
                  console.log('\nSimulating transaction...');
                  const simulation = await connection.simulateTransaction(claimTx, {
                    sigVerify: false,
                    commitment: 'confirmed'
                  });
                  
                  if (simulation.value.err) {
                    console.error('\n❌ SIMULATION FAILED!');
                    console.error('Error:', JSON.stringify(simulation.value.err, null, 2));
                    
                    if (simulation.value.logs) {
                      console.error('\nFull transaction logs:');
                      simulation.value.logs.forEach((log, idx) => {
                        console.error(`${idx}: ${log}`);
                      });
                    }
                    
                    // Try to decode the error
                    if (simulation.value.err && simulation.value.err.InstructionError) {
                      const [index, errorCode] = simulation.value.err.InstructionError;
                      console.error(`\nInstruction ${index} failed with error: ${JSON.stringify(errorCode)}`);
                    }
                    
                    continue;
                  }
                  
                  console.log('✅ Simulation successful!');
                  if (simulation.value.logs) {
                    console.log('\nSuccessful simulation logs:');
                    simulation.value.logs.forEach((log, idx) => {
                      console.log(`${idx}: ${log}`);
                    });
                  }
                  
                  // Send transaction
                  const signature = await connection.sendRawTransaction(claimTx.serialize());
                  console.log('Transaction sent:', signature);
                  await connection.confirmTransaction(signature, 'confirmed');
                  console.log('✅ Claimed successfully!');
                  
                } catch (claimError) {
                  console.error('\n❌ CLAIM ERROR!');
                  console.error('Error Type:', claimError.constructor.name);
                  console.error('Error Message:', claimError.message);
                  
                  // Check for SendTransactionError details
                  if (claimError.logs) {
                    console.error('\nError logs from transaction:');
                    claimError.logs.forEach((log, idx) => {
                      console.error(`${idx}: ${log}`);
                    });
                  }
                  
                  // Try to get more details
                  if (claimError.message && claimError.message.includes('custom program error')) {
                    const errorMatch = claimError.message.match(/0x([0-9a-fA-F]+)/);
                    if (errorMatch) {
                      const errorCode = parseInt(errorMatch[1], 16);
                      console.error(`\nCustom error code: ${errorCode} (0x${errorMatch[1]})`);
                    }
                  }
                  
                  console.error('\nFull error object:', JSON.stringify(claimError, null, 2));
                }
              }
            }
            
          } catch (cpError) {
            console.error('CP-AMM Error:', cpError.message);
            console.error('Stack:', cpError.stack);
          }
        }
        
        // Check if it's the token vault directly
        if (pool.address === TOKEN_B_VAULT || accountInfo.owner.toString() === TOKEN_PROGRAM_ID.toString()) {
          console.log('\n--- Token Account Details ---');
          try {
            const tokenAccount = await getAccount(connection, poolPubkey);
            console.log('Token Mint:', tokenAccount.mint.toString());
            console.log('Token Owner:', tokenAccount.owner.toString());
            console.log('Token Amount:', tokenAccount.amount.toString());
            console.log('Token UI Amount:', Number(tokenAccount.amount) / LAMPORTS_PER_SOL);
          } catch (tokenError) {
            console.log('Not a token account or error:', tokenError.message);
          }
        }
        
      } catch (error) {
        console.error(`\nError checking ${pool.name}:`, error.message);
        console.error('Stack:', error.stack);
      }
    }
    
    // Also check the vault directly
    console.log('\n=== Checking Token B Vault Directly ===');
    console.log('Vault address:', TOKEN_B_VAULT);
    try {
      const vaultPubkey = new PublicKey(TOKEN_B_VAULT);
      const vaultAccount = await getAccount(connection, vaultPubkey);
      console.log('Vault Owner:', vaultAccount.owner.toString());
      console.log('Vault Mint:', vaultAccount.mint.toString());
      console.log('Vault Amount:', (Number(vaultAccount.amount) / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
      
      // Check if the vault owner is the pool
      console.log('\nChecking if vault is owned by DAMM pool...');
      if (vaultAccount.owner.toString() === DAMM_V2_POOL) {
        console.log('✅ Vault is owned by DAMM V2 pool');
      } else if (vaultAccount.owner.toString() === SOLSCAN_POOL) {
        console.log('✅ Vault is owned by Solscan pool');
      } else {
        console.log('❓ Vault owner:', vaultAccount.owner.toString());
      }
      
    } catch (vaultError) {
      console.error('Vault check error:', vaultError.message);
    }
    
    // Final balance
    const finalBalance = await connection.getBalance(adminKeypair.publicKey);
    const totalClaimed = (finalBalance - initialBalance) / LAMPORTS_PER_SOL;
    
    console.log('\n====== FINAL RESULTS ======');
    console.log('Initial balance:', (initialBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Final balance:', (finalBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Total claimed:', totalClaimed.toFixed(6), 'SOL');

  } catch (error) {
    console.error('\n❌ MAIN ERROR:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the test
console.log('Starting pool type identification and claim test...\n');
testPoolTypeAndClaim();