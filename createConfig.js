// Backend function to create DBC config with EXACT 1B tokens
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const BN = require('bn.js');
const bs58 = require('bs58').default;
require('dotenv').config();

// Constants
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const NATIVE_SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Admin wallet from environment variable
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
if (!ADMIN_PRIVATE_KEY) {
  console.error('ERROR: ADMIN_PRIVATE_KEY environment variable is required');
  console.error('Expected public key: KAQmut31iGrghKrnaaJbv7FS87ez6JYkDrVPgLDjXnk');
  throw new Error('Missing ADMIN_PRIVATE_KEY');
}

async function createInkwellConfig() {
  try {
    console.log('====== CREATING INKWELL CONFIG (EXACT 1B TOKENS) ======');
    
    // Initialize connection
    const connection = new Connection(RPC_URL, 'confirmed');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    
    // Create admin keypair from private key
    const adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_PRIVATE_KEY));
    console.log('Admin wallet:', adminKeypair.publicKey.toString());
    
    // Verify it's the expected wallet
    if (adminKeypair.publicKey.toString() !== 'KAQmut31iGrghKrnaaJbv7FS87ez6JYkDrVPgLDjXnk') {
      throw new Error(`Wrong wallet! Expected KAQmut31iGrghKrnaaJbv7FS87ez6JYkDrVPgLDjXnk but got ${adminKeypair.publicKey.toString()}`);
    }
    
    // Check balance
    const balance = await connection.getBalance(adminKeypair.publicKey);
    console.log('Admin balance:', balance / LAMPORTS_PER_SOL, 'SOL');
    
    if (balance < 0.1 * LAMPORTS_PER_SOL) {
      throw new Error('Insufficient balance. Need at least 0.1 SOL for transaction fees');
    }
    
    // Generate new config keypair
    const configKeypair = Keypair.generate();
    console.log('New config address will be:', configKeypair.publicKey.toString());
    
    // EXACT curve parameters from Bags that mint 1B tokens with 9 decimals
    // These are the CRITICAL values that ensure exactly 1B tokens
    const bagsCurve = [
      {
        sqrtPrice: new BN("6401204812200420"),
        liquidity: new BN("3929368168768468756200000000000000")
      },
      {
        sqrtPrice: new BN("13043817825332782"),
        liquidity: new BN("2425988008058820449100000000000000")
      }
    ];
    
    // Config parameters - EXACT same as Bags except 4% fee instead of 2%
    const configParams = {
      poolFees: {
        baseFee: {
          cliffFeeNumerator: new BN(40_000_000), // 4% fee (40M/1B)
          firstFactor: 0,
          secondFactor: new BN(0),
          thirdFactor: new BN(0),
          baseFeeMode: 0 // flat fee
        },
        dynamicFee: null
      },
      collectFeeMode: 0, // Quote token only (SOL)
      migrationOption: 1, // DAMM V2
      activationType: 0, // Slot-based activation like Bags
      tokenType: 0, // SPL Token
      tokenDecimal: 9, // 9 decimals CRITICAL for 1B tokens
      migrationQuoteThreshold: new BN(20 * LAMPORTS_PER_SOL), // 20 SOL threshold
      partnerLpPercentage: 0, // u16
      partnerLockedLpPercentage: 50, // 50% to platform
      creatorLpPercentage: 0, // u16
      creatorLockedLpPercentage: 50, // 50% to creator
      sqrtStartPrice: new BN("3141367320245630"), // EXACT from Bags
      lockedVesting: {
        amountPerPeriod: new BN(0),
        cliffDurationFromMigrationTime: new BN(0),
        frequency: new BN(0),
        numberOfPeriod: new BN(0),
        cliffUnlockAmount: new BN(0),
      },
      migrationFeeOption: 0,
      tokenSupply: {
        preMigrationTokenSupply: new BN("1000000000000000000"),  // 1B tokens with 9 decimals
        postMigrationTokenSupply: new BN("1000000000000000000")  // 1B tokens with 9 decimals
      },
      creatorTradingFeePercentage: 50, // 50% of fees go to creator, 50% to platform
      tokenUpdateAuthority: 1, // immutable
      migrationFee: {
        feePercentage: 0,
        creatorFeePercentage: 0,
      },
      migratedPoolFee: {
        poolFeeBps: 0,
        collectFeeMode: 0,
        dynamicFee: 0,
      },
      padding: Array(7).fill(new BN(0)),
      curve: bagsCurve, // USE EXACT BAGS CURVE - THIS IS CRITICAL
    };
    
    // Create config transaction
    console.log('Creating config transaction...');
    console.log('Using Bags exact curve parameters for GUARANTEED 1B tokens');
    
    const createConfigTx = await dbcClient.partner.createConfig({
      config: configKeypair.publicKey,
      quoteMint: NATIVE_SOL_MINT,
      feeClaimer: adminKeypair.publicKey, // Admin wallet receives fees
      leftoverReceiver: adminKeypair.publicKey, // Admin wallet receives leftovers
      payer: adminKeypair.publicKey,
      ...configParams
    });
    
    // Add recent blockhash and sign
    createConfigTx.feePayer = adminKeypair.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    createConfigTx.recentBlockhash = blockhash;
    
    // Sign with both config and admin keypairs
    createConfigTx.sign(configKeypair, adminKeypair);
    
    // Send transaction
    console.log('Sending transaction...');
    const signature = await connection.sendRawTransaction(
      createConfigTx.serialize(),
      { 
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3
      }
    );
    
    console.log('Transaction sent:', signature);
    console.log('Waiting for confirmation...');
    
    // Wait for confirmation with timeout
    const confirmationTimeout = 60000; // 60 seconds
    const startTime = Date.now();
    
    while (Date.now() - startTime < confirmationTimeout) {
      try {
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        
        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        
        console.log('Transaction confirmed!');
        break;
      } catch (error) {
        if (Date.now() - startTime >= confirmationTimeout) {
          throw new Error('Transaction confirmation timeout');
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // Success!
    const result = {
      success: true,
      configAddress: configKeypair.publicKey.toString(),
      signature,
      adminWallet: adminKeypair.publicKey.toString(),
      details: {
        fee: '4% (2% creator, 2% platform)',
        tokenSupply: 'EXACTLY 1,000,000,000 tokens',
        decimals: 9,
        migrationThreshold: '20 SOL',
        curveType: 'Bags exact curve (guaranteed 1B tokens)'
      }
    };
    
    console.log('====== CONFIG CREATION COMPLETE ======');
    console.log('Config address:', result.configAddress);
    console.log('Transaction:', signature);
    console.log('Fee structure: 4% total (2% creator, 2% platform)');
    console.log('Token supply: EXACTLY 1B tokens with 9 decimals');
    console.log('View on Solscan:', `https://solscan.io/tx/${signature}`);
    console.log('');
    console.log('IMPORTANT: Update your environment variables:');
    console.log(`DBC_CONFIG_PUBKEY=${result.configAddress}`);
    
    return result;
    
  } catch (error) {
    console.error('====== ERROR CREATING CONFIG ======');
    console.error('Error:', error);
    
    return {
      success: false,
      error: error.message || 'Unknown error',
      details: error.toString()
    };
  }
}

// Export for use in other files
module.exports = {
  createInkwellConfig
};

// If run directly, execute the function
if (require.main === module) {
  createInkwellConfig()
    .then(result => {
      if (result.success) {
        console.log('\n✅ Config created successfully!');
        process.exit(0);
      } else {
        console.error('\n❌ Config creation failed');
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('Unexpected error:', error);
      process.exit(1);
    });
}