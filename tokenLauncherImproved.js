// Token launcher using Dynamic Bonding Curve - Improved Backend Implementation with comprehensive error handling
const { Connection, PublicKey, Keypair, TransactionExpiredBlockheightExceededError } = require('@solana/web3.js');
const { DynamicBondingCurveClient, deriveDbcPoolAddress } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const bs58 = require('bs58');
const BN = require('bn.js');
const { createClient } = require('@supabase/supabase-js');

// Native SOL mint address
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Initialize Supabase clients - SERVICE ROLE for storage, ANON for database
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || (!SUPABASE_ANON_KEY && !SUPABASE_SERVICE_ROLE_KEY)) {
  console.error('CRITICAL ERROR: Missing required environment variables');
  console.error('SUPABASE_URL:', SUPABASE_URL ? 'SET' : 'MISSING');
  console.error('SUPABASE_SERVICE_ROLE_KEY:', SUPABASE_SERVICE_ROLE_KEY ? 'SET' : 'MISSING');
  console.error('SUPABASE_ANON_KEY:', SUPABASE_ANON_KEY ? 'SET' : 'MISSING');
  throw new Error('Missing required Supabase credentials');
}

// Use SERVICE ROLE for storage operations (avoids signature verification errors)
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY, // Prefer service role key
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// Helius RPC endpoint with fallback
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const FALLBACK_RPC = "https://api.mainnet-beta.solana.com";

// Inkwell config address - 4% fee, 9 decimals, EXACTLY 1B tokens, 20 SOL threshold, FIXED SUPPLY
const INKWELL_CONFIG_ADDRESS = new PublicKey(
  process.env.DBC_CONFIG_PUBKEY || "D21YtyrW79hiGuVrNGNeiuDsZpNyVqM9QJhiHEvsPcE4"
);

// Validation functions
function validateMetadata(metadata) {
  const errors = [];
  
  if (!metadata.name || metadata.name.trim().length === 0) {
    errors.push('Token name is required');
  }
  if (metadata.name && metadata.name.length > 32) {
    errors.push('Token name must be 32 characters or less');
  }
  
  if (!metadata.symbol || metadata.symbol.trim().length === 0) {
    errors.push('Token symbol is required');
  }
  if (metadata.symbol && metadata.symbol.length > 10) {
    errors.push('Token symbol must be 10 characters or less');
  }
  if (metadata.symbol && !/^[A-Z0-9]+$/i.test(metadata.symbol)) {
    errors.push('Token symbol must contain only letters and numbers');
  }
  
  if (metadata.description && metadata.description.length > 500) {
    errors.push('Description must be 500 characters or less');
  }
  
  if (metadata.website && !isValidUrl(metadata.website)) {
    errors.push('Website must be a valid URL');
  }
  
  if (metadata.twitter && !isValidTwitterUrl(metadata.twitter)) {
    errors.push('Twitter must be a valid Twitter/X URL');
  }
  
  if (metadata.initialBuyAmount !== undefined) {
    const amount = parseFloat(metadata.initialBuyAmount);
    if (isNaN(amount) || amount < 0) {
      errors.push('Initial buy amount must be a positive number');
    }
    if (amount > 10) {
      errors.push('Initial buy amount cannot exceed 10 SOL');
    }
  }
  
  return errors;
}

function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function isValidTwitterUrl(string) {
  try {
    const url = new URL(string);
    return (url.hostname === 'twitter.com' || url.hostname === 'x.com' || 
            url.hostname === 'www.twitter.com' || url.hostname === 'www.x.com');
  } catch (_) {
    return false;
  }
}

// Parse private key with multiple format support
function parsePrivateKey(privateKeyString) {
  if (!privateKeyString) {
    throw new Error('Private key is required');
  }
  
  // Try base64 first (most common from our system)
  try {
    const secretKey = Buffer.from(privateKeyString, 'base64');
    if (secretKey.length === 64) {
      return Keypair.fromSecretKey(secretKey);
    }
  } catch (e) {
    // Continue to next format
  }
  
  // Try base58
  try {
    const decoded = bs58.decode(privateKeyString);
    if (decoded.length === 64) {
      return Keypair.fromSecretKey(decoded);
    }
  } catch (e) {
    // Continue to next format
  }
  
  // Try JSON array
  try {
    const keyArray = JSON.parse(privateKeyString);
    if (Array.isArray(keyArray) && keyArray.length === 64) {
      return Keypair.fromSecretKey(new Uint8Array(keyArray));
    }
  } catch (e) {
    // Continue to next format
  }
  
  // Try comma-separated values
  try {
    const values = privateKeyString.split(',').map(v => parseInt(v.trim()));
    if (values.length === 64 && values.every(v => !isNaN(v) && v >= 0 && v <= 255)) {
      return Keypair.fromSecretKey(new Uint8Array(values));
    }
  } catch (e) {
    // Failed all formats
  }
  
  throw new Error('Invalid private key format. Expected base64, base58, JSON array, or comma-separated values');
}

// Helper function to upload metadata following Metaplex standard
async function uploadMetadata(metadata, mintAddress) {
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Uploading metadata for ${mintAddress}, attempt ${attempt}`);
      
      let imageUrl = undefined;
      
      // Step 1: Upload image to Supabase storage if provided
      if (metadata.image) {
        // Determine file extension
        const fileExt = metadata.imageType?.split('/')[1] || 'png';
        const fileName = `token-${mintAddress}.${fileExt}`;
        const filePath = `posts/${fileName}`;
        
        let fileBuffer;
        
        // Handle different image formats
        if (Buffer.isBuffer(metadata.image)) {
          fileBuffer = metadata.image;
        } else if (typeof metadata.image === 'string') {
          if (metadata.image.startsWith('data:')) {
            // Data URL format
            const base64Data = metadata.image.split(',')[1];
            fileBuffer = Buffer.from(base64Data, 'base64');
          } else {
            // Raw base64
            fileBuffer = Buffer.from(metadata.image, 'base64');
          }
        } else {
          throw new Error('Invalid image format: must be Buffer or base64 string');
        }
        
        // Validate file size
        if (fileBuffer.length > 10 * 1024 * 1024) {
          throw new Error('Image file too large. Maximum size is 10MB.');
        }
        
        // Upload to Supabase storage with retry
        if (!supabase) {
          throw new Error('Supabase client not initialized. Check environment variables.');
        }
        
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('post-media')
          .upload(filePath, fileBuffer, {
            cacheControl: '3600',
            upsert: true,
            contentType: metadata.imageType || 'image/png'
          });
        
        if (uploadError) {
          console.error(`Image upload error on attempt ${attempt}:`, uploadError);
          if (attempt === maxRetries) {
            throw new Error(`Image upload failed after ${maxRetries} attempts: ${uploadError.message}`);
          }
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
          continue;
        }
        
        // Get public URL
        const { data: urlData } = supabase.storage
          .from('post-media')
          .getPublicUrl(filePath);
        
        imageUrl = urlData.publicUrl;
        console.log('Image uploaded successfully:', imageUrl);
      }

      // Step 2: Create Metaplex standard metadata JSON
      const metadataJson = {
        name: metadata.name.substring(0, 32), // Ensure max length
        symbol: metadata.symbol.substring(0, 10), // Ensure max length
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
      
      // Add optional fields if provided
      if (metadata.website) {
        metadataJson.external_url = metadata.website;
        metadataJson.attributes.push({ trait_type: "website", value: metadata.website });
      }
      
      if (metadata.twitter) {
        metadataJson.attributes.push({ trait_type: "twitter", value: metadata.twitter });
      }

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
        console.error(`Metadata upload error on attempt ${attempt}:`, metadataError);
        if (attempt === maxRetries) {
          throw new Error(`Metadata upload failed after ${maxRetries} attempts: ${metadataError.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      
      // Get public URL for metadata
      const { data: metadataUrlData } = supabase.storage
        .from('post-media')
        .getPublicUrl(metadataPath);
      
      console.log('Metadata uploaded successfully:', metadataUrlData.publicUrl);
      return metadataUrlData.publicUrl;
      
    } catch (error) {
      console.error(`Error in uploadMetadata attempt ${attempt}:`, error);
      lastError = error;
      
      if (attempt === maxRetries) {
        // Final attempt - try fallback
        try {
          console.log('Attempting fallback metadata upload...');
          const fallbackJson = {
            name: metadata.name.substring(0, 32),
            symbol: metadata.symbol.substring(0, 10),
            description: (metadata.description || "").substring(0, 500),
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
      }
    }
  }
  
  throw lastError || new Error('Failed to upload metadata after all attempts');
}

async function launchTokenDBC(metadata, userId, userPrivateKey) {
  // Validate inputs
  const validationErrors = validateMetadata(metadata);
  if (validationErrors.length > 0) {
    return {
      success: false,
      error: `Validation failed: ${validationErrors.join(', ')}`
    };
  }
  
  if (!userId) {
    return {
      success: false,
      error: 'User ID is required'
    };
  }
  
  let connection;
  let dbcClient;
  let userKeypair;
  let baseMintKP;
  
  try {
    // Initialize connection with fallback
    try {
      connection = new Connection(RPC_URL, 'confirmed');
      // Test connection
      await connection.getLatestBlockhash();
      console.log('Connected to Helius RPC');
    } catch (rpcError) {
      console.warn('Helius RPC failed, using fallback:', rpcError.message);
      connection = new Connection(FALLBACK_RPC, 'confirmed');
      await connection.getLatestBlockhash();
      console.log('Connected to fallback RPC');
    }
    
    // Create DBC client
    dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
    
    // Parse private key
    userKeypair = parsePrivateKey(userPrivateKey);
    console.log('User wallet:', userKeypair.publicKey.toString());
    
    // Check wallet balance
    const balance = await connection.getBalance(userKeypair.publicKey);
    const requiredBalance = 0.02 * 1e9; // 0.02 SOL for fees and rent
    
    if (balance < requiredBalance) {
      return {
        success: false,
        error: `Insufficient balance. Need at least 0.02 SOL, current balance: ${balance / 1e9} SOL`
      };
    }
    
    // Generate new mint keypair
    baseMintKP = Keypair.generate();
    console.log('New token mint:', baseMintKP.publicKey.toString());
    
    // Upload metadata
    const metadataUri = await uploadMetadata(metadata, baseMintKP.publicKey.toString());
    
    // Create pool transaction using the SDK
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
    
    // Get latest blockhash with retry
    let blockhash;
    let lastValidBlockHeight;
    const maxBlockhashRetries = 3;
    
    for (let i = 0; i < maxBlockhashRetries; i++) {
      try {
        const result = await connection.getLatestBlockhash('confirmed');
        blockhash = result.blockhash;
        lastValidBlockHeight = result.lastValidBlockHeight;
        break;
      } catch (error) {
        if (i === maxBlockhashRetries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Prepare transaction
    const transaction = createPoolTx;
    transaction.feePayer = userKeypair.publicKey;
    transaction.recentBlockhash = blockhash;
    
    // Sign with both keypairs
    transaction.sign(userKeypair, baseMintKP);
    
    // Send transaction with retry logic
    let signature;
    const maxSendRetries = 3;
    
    for (let i = 0; i < maxSendRetries; i++) {
      try {
        signature = await connection.sendRawTransaction(
          transaction.serialize(),
          { 
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3
          }
        );
        console.log(`Transaction sent: ${signature}`);
        break;
      } catch (error) {
        console.error(`Send attempt ${i + 1} failed:`, error.message);
        if (i === maxSendRetries - 1) throw error;
        
        // Check if blockhash expired
        if (error instanceof TransactionExpiredBlockheightExceededError || 
            error.message.includes('blockhash')) {
          // Get new blockhash and retry
          const result = await connection.getLatestBlockhash('confirmed');
          transaction.recentBlockhash = result.blockhash;
          transaction.sign(userKeypair, baseMintKP);
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
      }
    }
    
    // Wait for confirmation with timeout
    const confirmationTimeout = 60000; // 60 seconds
    const startTime = Date.now();
    
    while (Date.now() - startTime < confirmationTimeout) {
      try {
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        
        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        
        console.log('Transaction confirmed successfully');
        break;
      } catch (error) {
        if (Date.now() - startTime >= confirmationTimeout) {
          throw new Error('Transaction confirmation timeout');
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // Derive the pool address deterministically
    const poolAddress = deriveDbcPoolAddress(
      NATIVE_MINT, // quote mint (SOL)
      baseMintKP.publicKey, // base mint (our token)
      INKWELL_CONFIG_ADDRESS // config
    ).toString();
    
    console.log('Pool created at:', poolAddress);
    
    // Log to Supabase - CRITICAL for fee claiming
    try {
      // Insert into token_launches table (legacy)
      const { error: launchError } = await supabase
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
      
      if (launchError) {
        console.error('Failed to insert launch data:', launchError);
      }
      
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
            description: metadata.description,
            website: metadata.website,
            twitter: metadata.twitter,
            launch_transaction: signature,
            metadata_uri: metadataUri
          }
        });
      
      if (poolError) {
        console.error('Failed to insert pool data:', poolError);
      }
      
    } catch (dbError) {
      console.error('Database logging failed:', dbError);
      // Don't fail the launch if logging fails
    }
    
    // If initial buy amount is specified, perform the buy
    if (metadata.initialBuyAmount && metadata.initialBuyAmount > 0) {
      try {
        console.log(`Performing initial buy of ${metadata.initialBuyAmount} SOL...`);
        
        // Create buy transaction
        const buyTx = await dbcClient.pool.swap({
          owner: userKeypair.publicKey,
          pool: new PublicKey(poolAddress),
          amountIn: new BN(Math.floor(metadata.initialBuyAmount * 1e9)), // Convert SOL to lamports
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
        console.log(`Initial buy completed: ${buySignature}`);
      } catch (buyError) {
        console.error('Initial buy failed (non-critical):', buyError.message);
        // Don't fail the whole launch if buy fails
      }
    }
    
    // ONLY NOW that we have a successful launch, insert into user_posts table
    try {
      console.log('Inserting token launch into user_posts table...');
      
      // Get user details for the post
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('wallet_address, screen_name, profile_picture_url')
        .eq('id', userId)
        .single();
      
      if (userError) {
        console.error('Failed to fetch user data:', userError);
      } else {
        // Create the post content
        const postContent = `🚀 Just launched ${metadata.name} ($${metadata.symbol})!\n\n${metadata.description || ''}${metadata.website ? '\n\n🌐 ' + metadata.website : ''}${metadata.twitter ? '\n\n🐦 ' + metadata.twitter : ''}`;
        
        // Insert into user_posts
        const { error: postError } = await supabase
          .from('user_posts')
          .insert({
            user_id: userId,
            wallet_address: userData.wallet_address || userKeypair.publicKey.toString(),
            screen_name: userData.screen_name || 'Anonymous',
            profile_picture_url: userData.profile_picture_url,
            content: postContent,
            media_url: metadataUri, // Using the metadata URL as media
            media_type: 'image',
            token_symbol: metadata.symbol,
            token_name: metadata.name,
            token_mint: baseMintKP.publicKey.toString(),
            market_cap: 4200.00, // Default market cap
            fees_generated: 0.00
          });
        
        if (postError) {
          console.error('Failed to insert into user_posts:', postError);
        } else {
          console.log('Successfully inserted token launch into user_posts');
        }
      }
    } catch (postError) {
      console.error('Error inserting into user_posts (non-critical):', postError);
      // Don't fail the token launch if post creation fails
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
    
    // Provide user-friendly error messages
    let userMessage = "Unknown error occurred";
    
    if (error.message.includes('insufficient')) {
      userMessage = "Insufficient SOL balance for transaction fees";
    } else if (error.message.includes('blockhash')) {
      userMessage = "Network congestion detected, please try again";
    } else if (error.message.includes('timeout')) {
      userMessage = "Transaction timed out, please check Solscan for status";
    } else if (error.message.includes('0x1')) {
      userMessage = "Insufficient balance for transaction";
    } else if (error.message.includes('0x0')) {
      userMessage = "Account initialization failed";
    } else if (error.message.includes('upload')) {
      userMessage = "Failed to upload token metadata";
    } else {
      userMessage = error.message;
    }
    
    return {
      success: false,
      error: userMessage,
      details: error.message // Include full error for debugging
    };
  }
}

// Helper to get user's dev wallet private key from Supabase
async function getUserDevWallet(userId) {
  if (!userId) {
    return null;
  }
  
  try {
    const { data, error } = await supabase
      .from('users')
      .select('dev_wallet_private_key')
      .eq('id', userId)
      .single();
    
    if (error) {
      console.error('Database error fetching dev wallet:', error);
      return null;
    }
    
    if (!data?.dev_wallet_private_key) {
      console.log('No dev wallet found for user:', userId);
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
  uploadMetadata,
  validateMetadata,
  parsePrivateKey
};