// Script to find ALL positions in the DAMM v2 pool
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

// CP-AMM program ID
const CP_AMM_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

async function findAllPoolPositions() {
  try {
    console.log('====== FINDING ALL POSITIONS IN DAMM V2 POOL ======\n');
    
    if (!ADMIN_PRIVATE_KEY) {
      throw new Error('Missing ADMIN_PRIVATE_KEY environment variable');
    }

    const connection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000
    });
    
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    const adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_PRIVATE_KEY));
    
    console.log('Admin wallet:', adminKeypair.publicKey.toString());
    
    const initialBalance = await connection.getBalance(adminKeypair.publicKey);
    console.log('Initial balance:', (initialBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL\n');

    // Derive DAMM v2 pool address
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

    // Initialize CP-AMM
    const cpAmm = new CpAmm(connection);
    const poolState = await cpAmm.fetchPoolState(dammV2PoolAddress);
    console.log('Pool state fetched successfully\n');

    // Method 1: Try getAllPositionsByPool if available
    console.log('Method 1: Trying getAllPositionsByPool...');
    let allPositions = [];
    
    try {
      // Some versions have this method
      allPositions = await cpAmm.getAllPositionsByPool(dammV2PoolAddress);
      console.log(`Found ${allPositions.length} total positions in pool`);
      
      // Filter for admin's positions
      const adminPositions = allPositions.filter(pos => 
        pos.account?.owner?.equals(adminKeypair.publicKey) ||
        pos.owner?.equals(adminKeypair.publicKey)
      );
      console.log(`Found ${adminPositions.length} positions owned by admin`);
      
    } catch (error) {
      console.log('getAllPositionsByPool not available:', error.message);
    }

    // Method 2: Use getProgramAccounts to find all positions
    console.log('\nMethod 2: Using getProgramAccounts to scan for positions...');
    
    // Position discriminator (first 8 bytes of sha256("account:Position"))
    const POSITION_DISCRIMINATOR = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);
    
    const filters = [
      {
        memcmp: {
          offset: 0,
          bytes: bs58.encode(POSITION_DISCRIMINATOR)
        }
      },
      {
        dataSize: 408 // Size of position account
      }
    ];

    console.log('Scanning for position accounts...');
    const programAccounts = await connection.getProgramAccounts(
      new PublicKey(CP_AMM_PROGRAM_ID),
      {
        filters,
        commitment: 'confirmed'
      }
    );
    
    console.log(`Found ${programAccounts.length} total position accounts`);

    // Filter positions that belong to our pool
    const poolPositions = [];
    const poolAddressBytes = dammV2PoolAddress.toBuffer();
    
    for (const account of programAccounts) {
      const data = account.account.data;
      
      // Check if this position belongs to our pool
      // Pool address is typically at offset 8 (after discriminator)
      if (data.subarray(8, 40).equals(poolAddressBytes)) {
        poolPositions.push({
          pubkey: account.pubkey,
          account: account.account
        });
      }
    }
    
    console.log(`Found ${poolPositions.length} positions for our pool`);

    // Parse position data to find owners
    console.log('\nAnalyzing positions...');
    const positionsByOwner = new Map();
    
    for (const pos of poolPositions) {
      try {
        // Owner is typically at offset 40 (8 discriminator + 32 pool)
        const ownerBytes = pos.account.data.subarray(40, 72);
        const owner = new PublicKey(ownerBytes);
        
        if (!positionsByOwner.has(owner.toString())) {
          positionsByOwner.set(owner.toString(), []);
        }
        positionsByOwner.get(owner.toString()).push(pos.pubkey);
        
      } catch (e) {
        // Error parsing position
      }
    }

    console.log(`\nPositions by owner:`);
    for (const [owner, positions] of positionsByOwner.entries()) {
      console.log(`${owner}: ${positions.length} positions`);
      if (owner === adminKeypair.publicKey.toString()) {
        console.log('  ^ This is the admin wallet');
      }
    }

    // Method 3: Try getting positions through the SDK with proper pool state
    console.log('\nMethod 3: Getting user positions with detailed info...');
    const userPositions = await cpAmm.getUserPositionByPool(
      dammV2PoolAddress,
      adminKeypair.publicKey
    );
    
    console.log(`SDK found ${userPositions.length} positions for admin`);

    // If we found admin positions through scanning, try to claim from them
    const adminPosAddresses = positionsByOwner.get(adminKeypair.publicKey.toString()) || [];
    
    if (adminPosAddresses.length > userPositions.length) {
      console.log(`\n⚠️  Found ${adminPosAddresses.length} positions by scanning but SDK only returned ${userPositions.length}`);
      console.log('There might be additional positions to claim from!');
    }

    // Method 4: Check for locked liquidity positions
    console.log('\nMethod 4: Checking for locked liquidity positions...');
    
    // Some positions might be locked in escrow accounts
    const LOCK_ESCROW_DISCRIMINATOR = Buffer.from([77, 67, 98, 17, 5, 206, 52, 177]);
    
    const lockFilters = [
      {
        memcmp: {
          offset: 0,
          bytes: bs58.encode(LOCK_ESCROW_DISCRIMINATOR)
        }
      }
    ];

    try {
      const lockAccounts = await connection.getProgramAccounts(
        new PublicKey(CP_AMM_PROGRAM_ID),
        {
          filters: lockFilters,
          commitment: 'confirmed'
        }
      );
      
      console.log(`Found ${lockAccounts.length} lock escrow accounts`);
      
      // Check if any belong to admin
      let adminLocks = 0;
      for (const account of lockAccounts) {
        const data = account.account.data;
        // Owner is at specific offset in lock escrow
        try {
          const ownerBytes = data.subarray(8, 40); // Adjust offset as needed
          const owner = new PublicKey(ownerBytes);
          if (owner.equals(adminKeypair.publicKey)) {
            adminLocks++;
            console.log(`Found lock escrow for admin: ${account.pubkey.toString()}`);
          }
        } catch (e) {
          // Parse error
        }
      }
      console.log(`Admin has ${adminLocks} lock escrow accounts`);
      
    } catch (error) {
      console.log('Could not check for lock escrows:', error.message);
    }

    // Step 5: Attempt to claim from all found positions
    console.log('\n====== CLAIMING FROM ALL POSITIONS ======');
    
    let successCount = 0;
    let totalClaimed = 0;

    // First try SDK positions
    for (let i = 0; i < userPositions.length; i++) {
      const position = userPositions[i];
      console.log(`\nClaiming from SDK position ${i+1}/${userPositions.length}...`);
      console.log('Position:', position.position?.toString());
      
      try {
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

        claimTx.feePayer = adminKeypair.publicKey;
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        claimTx.recentBlockhash = blockhash;
        claimTx.sign(adminKeypair);
        
        const signature = await connection.sendRawTransaction(claimTx.serialize(), {
          skipPreflight: true
        });
        
        await connection.confirmTransaction(signature, 'confirmed');
        console.log('✅ Claimed! Signature:', signature);
        successCount++;
        
        const currentBalance = await connection.getBalance(adminKeypair.publicKey);
        const claimed = (currentBalance - initialBalance) / LAMPORTS_PER_SOL;
        console.log(`Total claimed so far: ${claimed.toFixed(6)} SOL`);
        
      } catch (error) {
        console.error('❌ Claim failed:', error.message);
      }
    }

    const finalBalance = await connection.getBalance(adminKeypair.publicKey);
    totalClaimed = (finalBalance - initialBalance) / LAMPORTS_PER_SOL;
    
    console.log('\n====== FINAL RESULTS ======');
    console.log('Total positions found in pool:', poolPositions.length);
    console.log('Admin positions found by SDK:', userPositions.length);
    console.log('Admin positions found by scanning:', adminPosAddresses.length);
    console.log('Successfully claimed from:', successCount, 'positions');
    console.log('\nInitial balance:', (initialBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Final balance:', (finalBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Total claimed:', totalClaimed.toFixed(6), 'SOL');
    console.log('Total claimed USD:', `$${(totalClaimed * 204).toFixed(2)}`);
    
    // Show remaining SOL in vault
    const vaultBalance = await connection.getTokenAccountBalance(poolState.tokenBVault);
    console.log('\nRemaining in vault:', vaultBalance.value.uiAmount, 'SOL');

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the script
console.log('Starting find all positions script...\n');
findAllPoolPositions();