// Token launcher using Dynamic Bonding Curve - BUNDLED VERSION to prevent sniping
const { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const { DynamicBondingCurveClient, deriveDbcPoolAddress } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const bs58 = require('bs58').default;
const BN = require('bn.js');
const { createClient } = require('@supabase/supabase-js');

// Native SOL mint address
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Initialize Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing required Supabase credentials');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Helius RPC endpoint
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Inkwell config address
const INKWELL_CONFIG_ADDRESS = new PublicKey("FpBnATp3c4i3sVo35u6zyZVpnUEDE6RmVsEofEK1YAMU");

// Import the original functions we need
const originalLauncher = require('./tokenLauncherImproved');

// Override the launchTokenDBC function with bundled version
async function launchTokenDBCBundled(devWalletPrivateKey, metadata) {
  console.log('=== LAUNCHING TOKEN WITH BUNDLED INITIAL BUY ===');
  
  try {
    // Convert private key to Keypair
    const userKeypair = Keypair.fromSecretKey(bs58.decode(devWalletPrivateKey));
    console.log('Dev wallet:', userKeypair.publicKey.toString());
    
    // Create connection
    const connection = new Connection(RPC_URL, 'confirmed');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    
    // Generate mint keypair
    const baseMintKP = Keypair.generate();
    const mintAddress = baseMintKP.publicKey.toString();
    console.log('Token mint:', mintAddress);
    
    // Calculate pool address
    const poolAddress = deriveDbcPoolAddress(
      NATIVE_MINT,
      baseMintKP.publicKey,
      INKWELL_CONFIG_ADDRESS
    ).toString();
    console.log('Pool address (calculated):', poolAddress);
    
    // Upload metadata
    const metadataUri = await originalLauncher.uploadMetadata(metadata, mintAddress);
    
    // Create pool transaction
    console.log('Creating pool transaction...');
    const createPoolTx = await dbcClient.pool.createPool({
      baseMint: baseMintKP.publicKey,
      config: INKWELL_CONFIG_ADDRESS,
      name: metadata.name.substring(0, 32),
      symbol: metadata.symbol.substring(0, 10),
      uri: metadataUri,
      payer: userKeypair.publicKey,
      poolCreator: userKeypair.publicKey,
    });
    
    // Get latest blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    // Create bundled transaction
    const bundledTransaction = new Transaction();
    
    // Add high priority fee to prevent front-running
    bundledTransaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 500000 // High priority
      })
    );
    
    bundledTransaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 800000 // Enough for both operations
      })
    );
    
    // Add pool creation instructions
    bundledTransaction.add(...createPoolTx.instructions);
    
    // Add initial buy instructions if specified
    if (metadata.initialBuyAmount && metadata.initialBuyAmount > 0) {
      console.log(`Creating initial buy instructions for ${metadata.initialBuyAmount} SOL...`);
      
      // Create buy transaction
      const buyTx = await dbcClient.pool.swap({
        owner: userKeypair.publicKey,
        pool: new PublicKey(poolAddress),
        amountIn: new BN(Math.floor(metadata.initialBuyAmount * 1e9)),
        minimumAmountOut: new BN(0),
        swapBaseForQuote: false, // Buy tokens with SOL
        referralTokenAccount: null,
        payer: userKeypair.publicKey
      });
      
      // Add buy instructions to the same transaction
      bundledTransaction.add(...buyTx.instructions);
      console.log('✅ Initial buy bundled with pool creation');
    }
    
    // Set transaction properties
    bundledTransaction.feePayer = userKeypair.publicKey;
    bundledTransaction.recentBlockhash = blockhash;
    
    // Sign with both keypairs
    bundledTransaction.sign(userKeypair, baseMintKP);
    
    console.log('Sending bundled transaction...');
    const signature = await connection.sendRawTransaction(
      bundledTransaction.serialize(),
      {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3
      }
    );
    
    console.log('Transaction sent:', signature);
    
    // Confirm transaction
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    }, 'confirmed');
    
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    console.log('✅ Pool created and initial buy completed in single transaction!');
    
    // Save to database
    const { error: dbError } = await supabase
      .from('user_posts')
      .update({
        pool_address: poolAddress,
        token_mint: mintAddress,
        initial_buy_amount: metadata.initialBuyAmount || 0,
        transaction_signature: signature
      })
      .eq('dev_wallet', userKeypair.publicKey.toString())
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (dbError) {
      console.error('Database update error:', dbError);
    }
    
    return {
      success: true,
      pool: poolAddress,
      mint: mintAddress,
      signature,
      initialBuyBundled: metadata.initialBuyAmount > 0
    };
    
  } catch (error) {
    console.error('Launch error:', error);
    return {
      success: false,
      error: error.message || 'Unknown error'
    };
  }
}

// Export the bundled version
module.exports = {
  launchTokenDBCBundled,
  // Re-export other functions from original
  ...originalLauncher
};