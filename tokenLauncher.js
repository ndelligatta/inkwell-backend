// Token launcher using Dynamic Bonding Curve - Backend Implementation
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { DynamicBondingCurveClient, deriveDbcPoolAddress } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const bs58 = require('bs58');
const BN = require('bn.js');
const { createClient } = require('@supabase/supabase-js');

// Native SOL mint address
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Initialize Supabase client without auth persistence (server-side)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
) : null;

// Helius RPC endpoint
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Inkwell config address - 4% fee, 9 decimals, EXACTLY 1B tokens, 20 SOL threshold, FIXED SUPPLY
const INKWELL_CONFIG_ADDRESS = new PublicKey(
  process.env.DBC_CONFIG_PUBKEY || "D21YtyrW79hiGuVrNGNeiuDsZpNyVqM9QJhiHEvsPcE4"
);

// Helper function to upload metadata following Metaplex standard
async function uploadMetadata(metadata, mintAddress) {
  try {
    let imageUrl = undefined;
    
    // Step 1: Upload image to Supabase storage if provided
    if (metadata.image) {
      // If image is provided as base64 or buffer
      const fileExt = metadata.imageType?.split('/')[1] || 'png';
      const fileName = `token-${mintAddress}.${fileExt}`;
      const filePath = `posts/${fileName}`;
      
      let fileBuffer;
      if (typeof metadata.image === 'string' && metadata.image.startsWith('data:')) {
        // Handle base64 data URL
        const base64Data = metadata.image.split(',')[1];
        fileBuffer = Buffer.from(base64Data, 'base64');
      } else if (Buffer.isBuffer(metadata.image)) {
        fileBuffer = metadata.image;
      } else if (typeof metadata.image === 'string') {
        // Assume it's base64 without data URL prefix
        fileBuffer = Buffer.from(metadata.image, 'base64');
      } else {
        throw new Error('Invalid image format');
      }
      
      // Check file size
      if (fileBuffer.length > 2 * 1024 * 1024) {
        throw new Error('Image file too large. Please use an image under 2MB.');
      }
      
      // Upload to Supabase storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('post-media')
        .upload(filePath, fileBuffer, {
          cacheControl: '3600',
          upsert: true,
          contentType: metadata.imageType || 'image/png'
        });
      
      if (uploadError) {
        console.error('Error uploading image:', uploadError);
        throw new Error(`Image upload failed: ${uploadError.message}`);
      }
      
      // Get public URL
      const { data: urlData } = supabase.storage
        .from('post-media')
        .getPublicUrl(filePath);
      
      imageUrl = urlData.publicUrl;
    }

    // Step 2: Create Metaplex standard metadata JSON
    const metadataJson = {
      name: metadata.name,
      symbol: metadata.symbol,
      description: metadata.description || "",
      image: imageUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${mintAddress}`,
      // Optional fields
      external_url: metadata.website || undefined,
      attributes: [
        metadata.website && { trait_type: "website", value: metadata.website },
        metadata.twitter && { trait_type: "twitter", value: metadata.twitter }
      ].filter(Boolean)
    };

    // Step 3: Upload metadata JSON to Supabase
    const metadataBuffer = Buffer.from(JSON.stringify(metadataJson, null, 2));
    const metadataPath = `posts/token-metadata-${mintAddress}.json`;
    
    const { data: metadataUpload, error: metadataError } = await supabase.storage
      .from('post-media')
      .upload(metadataPath, metadataBuffer, {
        cacheControl: '3600',
        upsert: true,
        contentType: 'application/json'
      });
    
    if (metadataError) {
      console.error('Error uploading metadata:', metadataError);
      throw new Error(`Metadata upload failed: ${metadataError.message}`);
    }
    
    // Get public URL for metadata
    const { data: metadataUrlData } = supabase.storage
      .from('post-media')
      .getPublicUrl(metadataPath);
    
    return metadataUrlData.publicUrl;
    
  } catch (error) {
    console.error("Error in uploadMetadata:", error);
    
    // If upload fails, try to upload a minimal metadata JSON
    try {
      const fallbackJson = {
        name: metadata.name,
        symbol: metadata.symbol,
        description: metadata.description || "",
        image: `https://api.dicebear.com/7.x/identicon/svg?seed=${mintAddress}`
      };
      
      const fallbackBuffer = Buffer.from(JSON.stringify(fallbackJson, null, 2));
      const fallbackPath = `posts/token-metadata-${mintAddress}-fallback.json`;
      
      const { data: fallbackUpload, error: fallbackError } = await supabase.storage
        .from('post-media')
        .upload(fallbackPath, fallbackBuffer, {
          cacheControl: '3600',
          upsert: true,
          contentType: 'application/json'
        });
      
      if (!fallbackError) {
        const { data: fallbackUrlData } = supabase.storage
          .from('post-media')
          .getPublicUrl(fallbackPath);
        
        console.log('Using fallback metadata URL:', fallbackUrlData.publicUrl);
        return fallbackUrlData.publicUrl;
      }
    } catch (fallbackError) {
      console.error('Fallback upload also failed:', fallbackError);
    }
    
    throw new Error('Failed to upload metadata');
  }
}

async function launchTokenDBC(metadata, userId, userPrivateKey) {
  try {
    // Initialize connection
    const connection = new Connection(RPC_URL, 'confirmed');
    
    // Create DBC client
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    
    // Create keypair from private key
    let userKeypair;
    try {
      // The private key is stored as base64, decode it
      const secretKey = Buffer.from(userPrivateKey, 'base64');
      userKeypair = Keypair.fromSecretKey(secretKey);
    } catch (e) {
      // If base64 fails, try base58
      try {
        userKeypair = Keypair.fromSecretKey(bs58.decode(userPrivateKey));
      } catch (e2) {
        // If that fails, try parsing as JSON array
        try {
          const keyArray = JSON.parse(userPrivateKey);
          userKeypair = Keypair.fromSecretKey(new Uint8Array(keyArray));
        } catch (e3) {
          console.error('Invalid private key format. Expected base64, base58 string or JSON array');
          throw new Error('Invalid private key format');
        }
      }
    }
    
    // Generate new mint keypair
    const baseMintKP = Keypair.generate();
    
    // Upload metadata
    const metadataUri = await uploadMetadata(metadata, baseMintKP.publicKey.toString());
    
    // Create pool transaction using the SDK
    const createPoolTx = await dbcClient.pool.createPool({
      baseMint: baseMintKP.publicKey,
      config: INKWELL_CONFIG_ADDRESS,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadataUri,
      payer: userKeypair.publicKey,
      poolCreator: userKeypair.publicKey,
    });
    
    // Get latest blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    // The SDK returns a transaction, not an object with transaction property
    const transaction = createPoolTx;
    transaction.feePayer = userKeypair.publicKey;
    transaction.recentBlockhash = blockhash;
    
    // Sign with both keypairs
    transaction.sign(userKeypair, baseMintKP);
    
    // Send transaction
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { 
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      }
    );
    
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    // Derive the pool address deterministically
    const poolAddress = deriveDbcPoolAddress(
      NATIVE_MINT, // quote mint (SOL)
      baseMintKP.publicKey, // base mint (our token)
      INKWELL_CONFIG_ADDRESS // config
    ).toString();
    
    // Log to Supabase - CRITICAL for fee claiming
    try {
      // Insert into token_launches table (legacy)
      await supabase
        .from('token_launches')
        .insert({
          user_id: userId,
          token_mint: baseMintKP.publicKey.toString(),
          pool_address: poolAddress,
          config_address: INKWELL_CONFIG_ADDRESS.toString(),
          transaction_signature: signature,
          launch_type: 'dbc',
          initial_buy_amount: metadata.initialBuyAmount || 0
        });
      
      // Insert into new token_pools table for proper tracking
      const { error: poolError } = await supabase
        .from('token_pools')
        .insert({
          pool_address: poolAddress,
          token_mint: baseMintKP.publicKey.toString(),
          config_address: INKWELL_CONFIG_ADDRESS.toString(),
          user_id: userId,
          status: 'active',
          pool_type: 'dbc',
          initial_supply: '1000000000', // 1B tokens with 9 decimals
          curve_type: 'exponential',
          buy_fee_bps: 400, // 4% fee
          sell_fee_bps: 400,
          migration_threshold: 20, // 20 SOL
          metadata: {
            name: metadata.name,
            symbol: metadata.symbol,
            launch_transaction: signature
          }
        });
      
      if (poolError) {
        console.error('Failed to insert pool data:', poolError);
      }
      
    } catch (e) {
      console.error('Failed to log launch:', e);
    }
    
    // If initial buy amount is specified, perform the buy
    if (metadata.initialBuyAmount && metadata.initialBuyAmount > 0) {
      try {
        // Create buy transaction
        const buyTx = await dbcClient.pool.swap({
          owner: userKeypair.publicKey,
          pool: new PublicKey(poolAddress),
          amountIn: new BN(metadata.initialBuyAmount * 1e9), // Convert SOL to lamports
          minimumAmountOut: new BN(0), // Accept any amount (can be improved with slippage calculation)
          swapBaseForQuote: false, // false = buy tokens (SOL -> Token)
          referralTokenAccount: null,
          payer: userKeypair.publicKey
        });
        
        // Sign and send buy transaction
        buyTx.feePayer = userKeypair.publicKey;
        buyTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        buyTx.sign(userKeypair);
        
        const buySignature = await connection.sendRawTransaction(
          buyTx.serialize(),
          { skipPreflight: false }
        );
        
        await connection.confirmTransaction(buySignature, 'confirmed');
      } catch (buyError) {
        console.error('Initial buy failed:', buyError);
        // Don't fail the whole launch if buy fails
      }
    }
    
    return {
      success: true,
      mintAddress: baseMintKP.publicKey.toString(),
      poolAddress: poolAddress,
      transactionSignature: signature,
      solscanUrl: `https://solscan.io/tx/${signature}`,
    };
    
  } catch (error) {
    console.error("Error launching token with DBC:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

// Helper to get user's dev wallet private key from Supabase
async function getUserDevWallet(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('dev_wallet_private_key')
      .eq('id', userId)
      .single();
    
    if (error || !data?.dev_wallet_private_key) {
      console.error('Dev wallet not found for user:', userId, error);
      return null;
    }
    
    return data.dev_wallet_private_key;
  } catch (error) {
    console.error('Error fetching dev wallet:', error);
    return null;
  }
}

module.exports = {
  launchTokenDBC,
  getUserDevWallet,
  uploadMetadata
};