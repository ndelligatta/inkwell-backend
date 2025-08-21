// Token launcher with SERVICE ROLE key for storage access
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { DynamicBondingCurveClient, deriveDbcPoolAddress } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const bs58 = require('bs58');
const BN = require('bn.js');
const { createClient } = require('@supabase/supabase-js');

// Native SOL mint address
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Get Supabase SERVICE ROLE key from environment
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Use SERVICE ROLE for storage operations, ANON for database
const supabaseStorage = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
) : null;

// Use ANON key for database operations
const supabaseDb = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(
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

// Inkwell config address
const INKWELL_CONFIG_ADDRESS = new PublicKey(
  process.env.DBC_CONFIG_PUBKEY || "D21YtyrW79hiGuVrNGNeiuDsZpNyVqM9QJhiHEvsPcE4"
);

// Helper function to upload metadata
async function uploadMetadata(metadata, mintAddress) {
  try {
    if (!supabaseStorage) {
      // Fallback to ANON key if no service role key
      if (!supabaseDb) {
        throw new Error('No Supabase client available for uploads');
      }
      console.warn('Using ANON key for storage - may fail if bucket requires auth');
    }
    
    const supabase = supabaseStorage || supabaseDb;
    let imageUrl = undefined;
    
    // Upload image if provided
    if (metadata.image) {
      const fileExt = metadata.imageType?.split('/')[1] || 'png';
      const fileName = `token-${mintAddress}.${fileExt}`;
      const filePath = `posts/${fileName}`;
      
      let fileBuffer;
      if (Buffer.isBuffer(metadata.image)) {
        fileBuffer = metadata.image;
      } else if (typeof metadata.image === 'string') {
        if (metadata.image.startsWith('data:')) {
          const base64Data = metadata.image.split(',')[1];
          fileBuffer = Buffer.from(base64Data, 'base64');
        } else {
          fileBuffer = Buffer.from(metadata.image, 'base64');
        }
      } else {
        throw new Error('Invalid image format');
      }
      
      if (fileBuffer.length > 2 * 1024 * 1024) {
        throw new Error('Image file too large. Maximum size is 2MB.');
      }
      
      // Try upload with service role key first
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('post-media')
        .upload(filePath, fileBuffer, {
          cacheControl: '3600',
          upsert: true,
          contentType: metadata.imageType || 'image/png'
        });
      
      if (uploadError) {
        console.error('Storage upload error:', uploadError);
        throw new Error(`Image upload failed: ${uploadError.message}`);
      }
      
      const { data: urlData } = supabase.storage
        .from('post-media')
        .getPublicUrl(filePath);
      
      imageUrl = urlData.publicUrl;
    }

    // Create metadata JSON
    const metadataJson = {
      name: metadata.name.substring(0, 32),
      symbol: metadata.symbol.substring(0, 10),
      description: (metadata.description || "").substring(0, 500),
      image: imageUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${mintAddress}`,
      attributes: [],
      properties: {
        files: imageUrl ? [{
          uri: imageUrl,
          type: metadata.imageType || 'image/png'
        }] : [],
        category: "image"
      }
    };
    
    if (metadata.website) {
      metadataJson.external_url = metadata.website;
      metadataJson.attributes.push({ trait_type: "website", value: metadata.website });
    }
    
    if (metadata.twitter) {
      metadataJson.attributes.push({ trait_type: "twitter", value: metadata.twitter });
    }

    // Upload metadata JSON
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
      console.error('Metadata upload error:', metadataError);
      throw new Error(`Metadata upload failed: ${metadataError.message}`);
    }
    
    const { data: metadataUrlData } = supabase.storage
      .from('post-media')
      .getPublicUrl(metadataPath);
    
    return metadataUrlData.publicUrl;
    
  } catch (error) {
    console.error("Error in uploadMetadata:", error);
    throw error;
  }
}

async function launchTokenDBC(metadata, userId, userPrivateKey) {
  try {
    // Parse private key
    let userKeypair;
    try {
      const secretKey = Buffer.from(userPrivateKey, 'base64');
      userKeypair = Keypair.fromSecretKey(secretKey);
    } catch (e) {
      try {
        userKeypair = Keypair.fromSecretKey(bs58.decode(userPrivateKey));
      } catch (e2) {
        try {
          const keyArray = JSON.parse(userPrivateKey);
          userKeypair = Keypair.fromSecretKey(new Uint8Array(keyArray));
        } catch (e3) {
          throw new Error('Invalid private key format');
        }
      }
    }
    
    // Initialize connection and client
    const connection = new Connection(RPC_URL, 'confirmed');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    
    // Generate new mint keypair
    const baseMintKP = Keypair.generate();
    console.log('New token mint:', baseMintKP.publicKey.toString());
    
    // Upload metadata
    const metadataUri = await uploadMetadata(metadata, baseMintKP.publicKey.toString());
    
    // Create pool transaction
    const createPoolTx = await dbcClient.pool.createPool({
      baseMint: baseMintKP.publicKey,
      config: INKWELL_CONFIG_ADDRESS,
      name: metadata.name.substring(0, 32),
      symbol: metadata.symbol.substring(0, 10),
      uri: metadataUri,
      payer: userKeypair.publicKey,
      poolCreator: userKeypair.publicKey,
    });
    
    // Get blockhash and sign
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    createPoolTx.feePayer = userKeypair.publicKey;
    createPoolTx.recentBlockhash = blockhash;
    createPoolTx.sign(userKeypair, baseMintKP);
    
    // Send transaction
    const signature = await connection.sendRawTransaction(
      createPoolTx.serialize(),
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
    
    // Derive pool address
    const poolAddress = deriveDbcPoolAddress(
      NATIVE_MINT,
      baseMintKP.publicKey,
      INKWELL_CONFIG_ADDRESS
    ).toString();
    
    // Log to database using ANON key client
    if (supabaseDb) {
      try {
        await supabaseDb
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
        
        await supabaseDb
          .from('token_pools')
          .insert({
            pool_address: poolAddress,
            token_mint: baseMintKP.publicKey.toString(),
            config_address: INKWELL_CONFIG_ADDRESS.toString(),
            user_id: userId,
            status: 'active',
            pool_type: 'dbc',
            initial_supply: '1000000000',
            curve_type: 'exponential',
            buy_fee_bps: 400,
            sell_fee_bps: 400,
            migration_threshold: 20,
            metadata: {
              name: metadata.name,
              symbol: metadata.symbol,
              description: metadata.description,
              website: metadata.website,
              twitter: metadata.twitter,
              launch_transaction: signature,
              metadata_uri: metadataUri
            }
          });
      } catch (dbError) {
        console.error('Database logging failed:', dbError);
      }
    }
    
    // Initial buy if specified
    if (metadata.initialBuyAmount && metadata.initialBuyAmount > 0) {
      try {
        const buyTx = await dbcClient.pool.swap({
          owner: userKeypair.publicKey,
          pool: new PublicKey(poolAddress),
          amountIn: new BN(Math.floor(metadata.initialBuyAmount * 1e9)),
          minimumAmountOut: new BN(0),
          swapBaseForQuote: false,
          referralTokenAccount: null,
          payer: userKeypair.publicKey
        });
        
        buyTx.feePayer = userKeypair.publicKey;
        buyTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        buyTx.sign(userKeypair);
        
        const buySignature = await connection.sendRawTransaction(
          buyTx.serialize(),
          { skipPreflight: false }
        );
        
        await connection.confirmTransaction(buySignature, 'confirmed');
        console.log(`Initial buy completed: ${buySignature}`);
      } catch (buyError) {
        console.error('Initial buy failed:', buyError);
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
    console.error("Error launching token:", error);
    return {
      success: false,
      error: error.message || "Unknown error",
      details: error.message
    };
  }
}

// Get user's dev wallet
async function getUserDevWallet(userId) {
  if (!userId || !supabaseDb) {
    return null;
  }
  
  try {
    const { data, error } = await supabaseDb
      .from('users')
      .select('dev_wallet_private_key')
      .eq('id', userId)
      .single();
    
    if (error || !data?.dev_wallet_private_key) {
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