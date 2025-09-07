// Server uses environment variables from Railway, not .env file

// Log environment variables to debug
console.log('Environment variables loaded:');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET' : 'NOT SET');
console.log('SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'SET (hidden)' : 'NOT SET');
console.log('DBC_CONFIG_PUBKEY:', process.env.DBC_CONFIG_PUBKEY || 'NOT SET');
console.log('PORT:', process.env.PORT || '3001');

const express = require('express');
const cors = require('cors');
const multer = require('multer');

// Import AFTER dotenv is loaded
const { 
  launchTokenDBC, 
  getUserDevWallet, 
  validateMetadata,
  prepareLaunchTokenTransaction,
  broadcastSignedTransaction
} = require('./tokenLauncherImproved');
const { createInkwellConfig } = require('./createConfig');
const { claimPoolFees, getPoolFeeMetrics } = require('./claimPlatformFees');
const { 
  claimCreatorFees, 
  claimAllCreatorFees, 
  checkAvailableCreatorFees,
  prepareCreatorClaimTxDBC,
  prepareCreatorClaimTxDammV2,
  checkPoolMigrationOfficial,
  getMigratedPoolAddress,
  broadcastSignedClaimTx
} = require('./claimCreatorFees');
const { getLifetimeFees, updateAllPoolsLifetimeFees } = require('./getLifetimeFees');
const { updateUserLifetimeFees, updateAllUsersLifetimeFees } = require('./updateUserLifetimeFees');
const authRoutes = require('./routes/auth');

// START KEYPAIR WORKER IN BACKGROUND
console.log('\n🚀🚀🚀 STARTING KEYPAIR GENERATION WORKER 🚀🚀🚀');
try {
  require('./keypairWorker'); // This starts the worker automatically
  console.log('🚀 Keypair worker started successfully!\n');
} catch (error) {
  console.error('❌ FAILED TO START KEYPAIR WORKER:', error);
  console.error('Error details:', error.message);
  console.error('Stack:', error.stack);
}

const app = express();
const PORT = process.env.PORT || 3001;
// Strict Helius RPC for fee-claim flows
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null;

// CORS configuration - allow specific origins
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:3000',
      'https://blockparty.fun',
      'https://www.blockparty.fun',
      'https://inkwell-feed.netlify.app'
    ];
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all origins for now
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};

// Middleware
app.use(cors(corsOptions));

// Additional CORS headers for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Configure multer for file uploads (in memory)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Auth routes
app.use('/api/auth', authRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Inkwell backend is running' });
});

// Main token launch endpoint
app.post('/api/launch-token', upload.single('image'), async (req, res) => {
  try {
    const { 
      name, 
      symbol, 
      description, 
      website, 
      twitter, 
      initialBuyAmount,
      userId,
      userPrivateKey // Dev wallet private key
    } = req.body;

    // Validate required fields
    if (!name || !symbol || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, symbol, and userId are required'
      });
    }

    // Get user's dev wallet if not provided
    let privateKey = userPrivateKey;
    if (!privateKey) {
      privateKey = await getUserDevWallet(userId);
      if (!privateKey) {
        return res.status(400).json({
          success: false,
          error: 'User dev wallet not found. Please generate a dev wallet first.'
        });
      }
    }

    // Prepare metadata - ensure website and twitter are properly handled
    const metadata = {
      name: name.trim(),
      symbol: symbol.trim(),
      description: description?.trim() || '',
      // Only include website/twitter if they have actual content
      website: website?.trim() || undefined,
      // ALWAYS include twitter - use BlockParty as fallback
      twitter: twitter?.trim() || 'https://x.com/blockpartysol',
      initialBuyAmount: parseFloat(initialBuyAmount) || 0.01
    };

    // Handle image upload if provided
    if (req.file) {
      // Convert file buffer to base64
      metadata.image = req.file.buffer;
      metadata.imageType = req.file.mimetype;
    } else if (req.body.imageBase64) {
      // Handle base64 image from request body
      metadata.image = req.body.imageBase64;
      metadata.imageType = req.body.imageType || 'image/png';
    }

    // Launch token
    const result = await launchTokenDBC(metadata, userId, privateKey);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }

  } catch (error) {
    console.error('Error in /api/launch-token:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Prepare a transaction for client-side signing with Privy
app.post('/api/launch-token/prepare', upload.single('image'), async (req, res) => {
  try {
    const { 
      name, symbol, description, website, twitter, initialBuyAmount,
      userId, walletAddress
    } = req.body;

    if (!name || !symbol || !userId || !walletAddress) {
      return res.status(400).json({ success: false, error: 'name, symbol, userId, and walletAddress are required' });
    }

    const metadata = {
      name: name.trim(),
      symbol: symbol.trim(),
      description: description?.trim() || '',
      website: website?.trim() || undefined,
      twitter: twitter?.trim() || 'https://x.com/blockpartysol',
      initialBuyAmount: parseFloat(initialBuyAmount) || 0.01
    };

    // Handle image (optional)
    if (req.file) {
      metadata.image = req.file.buffer.toString('base64');
      metadata.imageType = req.file.mimetype;
    } else if (req.body.imageBase64) {
      metadata.image = req.body.imageBase64;
      metadata.imageType = req.body.imageType || 'image/png';
    }

    const result = await prepareLaunchTokenTransaction(metadata, userId, walletAddress);
    const status = result.success ? 200 : 400;
    res.status(status).json(result);
  } catch (error) {
    console.error('Error in /api/launch-token/prepare:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

// Broadcast a fully-signed transaction produced by the client (Privy)
app.post('/api/launch-token/broadcast', async (req, res) => {
  try {
    const { signedTxBase64, userId, mintAddress, poolAddress } = req.body;
    const result = await broadcastSignedTransaction({ signedTxBase64, userId, mintAddress, poolAddress });
    const status = result.success ? 200 : 400;
    res.status(status).json(result);
  } catch (error) {
    console.error('Error in /api/launch-token/broadcast:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

// SPAM TEST endpoint - hardcoded values for testing
app.post('/api/spam-launch-token', upload.single('image'), async (req, res) => {
  try {
    // HARDCODED VALUES FOR TESTING
    const HARDCODED_PRIVATE_KEY = 'TgWKJ6WPfhPiG9mV0IuhTOruLvNwa+FkEAzKSzBpMSp+CmrIr6TOs7SMwEicbv1ePBl4XBRDtm0czkKhl9Msdw==';
    const HARDCODED_USER_ID = 'spam-test-user'; // Fake user ID for testing
    
    // Hardcoded metadata
    const metadata = {
      name: 'PARTY',
      symbol: 'PARTY',
      description: 'Transforming the way that content is monetized. BlockParty is the first social media platform to tokenize content, allowing you to get paid every time you post.',
      website: 'https://blockparty.fun/',
      twitter: 'https://x.com/blockpartysol',
      initialBuyAmount: 0.01
    };

    // Read the hardcoded image file
    const fs = require('fs');
    const path = require('path');
    const imagePath = 'c:\\Users\\james\\Downloads\\Untitled design (11).png';
    
    try {
      if (fs.existsSync(imagePath)) {
        const imageBuffer = fs.readFileSync(imagePath);
        metadata.image = imageBuffer;
        metadata.imageType = 'image/png';
        console.log('Loaded hardcoded image from:', imagePath);
      } else {
        console.warn('Hardcoded image not found at:', imagePath);
        // Continue without image
      }
    } catch (imageError) {
      console.error('Error loading hardcoded image:', imageError);
      // Continue without image
    }

    console.log('=== SPAM LAUNCH TOKEN ===');
    console.log('Using hardcoded values:');
    console.log('Name:', metadata.name);
    console.log('Symbol:', metadata.symbol);
    console.log('Website:', metadata.website);
    console.log('Twitter:', metadata.twitter);
    console.log('Initial Buy:', metadata.initialBuyAmount);
    console.log('Image loaded:', !!metadata.image);

    // Launch token using the exact same function as regular endpoint
    const result = await launchTokenDBC(metadata, HARDCODED_USER_ID, HARDCODED_PRIVATE_KEY);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }

  } catch (error) {
    console.error('Error in /api/spam-launch-token:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Alternative endpoint for launching with metadata passed directly
app.post('/api/launch-token-json', async (req, res) => {
  try {
    const { 
      metadata,
      userId,
      userPrivateKey // Dev wallet private key
    } = req.body;

    // Validate required fields
    if (!metadata?.name || !metadata?.symbol || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: metadata.name, metadata.symbol, and userId are required'
      });
    }

    // Get user's dev wallet if not provided
    let privateKey = userPrivateKey;
    if (!privateKey) {
      privateKey = await getUserDevWallet(userId);
      if (!privateKey) {
        return res.status(400).json({
          success: false,
          error: 'User dev wallet not found. Please generate a dev wallet first.'
        });
      }
    }

    // Launch token
    const result = await launchTokenDBC(metadata, userId, privateKey);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }

  } catch (error) {
    console.error('Error in /api/launch-token-json:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Get user's dev wallet endpoint
app.get('/api/dev-wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const privateKey = await getUserDevWallet(userId);
    
    if (privateKey) {
      // Only return public key for security
      const { Keypair } = require('@solana/web3.js');
      const bs58 = require('bs58');
      
      let publicKey;
      try {
        const secretKey = Buffer.from(privateKey, 'base64');
        const keypair = Keypair.fromSecretKey(secretKey);
        publicKey = keypair.publicKey.toString();
      } catch (e) {
        try {
          const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
          publicKey = keypair.publicKey.toString();
        } catch (e2) {
          const keyArray = JSON.parse(privateKey);
          const keypair = Keypair.fromSecretKey(new Uint8Array(keyArray));
          publicKey = keypair.publicKey.toString();
        }
      }
      
      res.json({
        success: true,
        publicKey,
        hasDevWallet: true
      });
    } else {
      res.json({
        success: false,
        hasDevWallet: false,
        error: 'Dev wallet not found for user'
      });
    }
  } catch (error) {
    console.error('Error getting dev wallet:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Create new DBC config endpoint - protected with same auth as fee claiming
app.post('/api/create-config', async (req, res) => {
  try {
    console.log('====== CREATE CONFIG ENDPOINT ======');
    console.log('Request from:', req.headers.origin || 'Unknown origin');
    console.log('Authorization:', req.headers.authorization ? 'Present' : 'Missing');
    
    // Use same authentication as fee claiming endpoint
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${process.env.ADMIN_AUTH_TOKEN || 'admin-secret'}`) {
      console.error('Unauthorized request - missing or invalid auth token');
      return res.status(401).json({
        success: false,
        error: 'Unauthorized. Admin authentication required.'
      });
    }
    
    console.log('Creating new DBC config...');
    
    // Create the config using the same admin wallet as fee claiming
    const result = await createInkwellConfig();
    
    console.log('Config creation result:', result.success ? 'SUCCESS' : 'FAILED');
    if (!result.success) {
      console.error('Config creation failed:', result.error);
    } else {
      console.log('New config address:', result.configAddress);
    }
    
    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }
    
  } catch (error) {
    console.error('====== ERROR IN CONFIG ENDPOINT ======');
    console.error('Error:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      details: error.toString()
    });
  }
});

// Claim platform fees endpoint
app.post('/api/claim-platform-fees', async (req, res) => {
  try {
    console.log('====== CLAIM PLATFORM FEES ENDPOINT ======');
    console.log('Request from:', req.headers.origin || 'Unknown origin');
    console.log('Authorization:', req.headers.authorization ? 'Present' : 'Missing');
    
    // This endpoint should be protected
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${process.env.ADMIN_AUTH_TOKEN || 'admin-secret'}`) {
      console.error('Unauthorized request - missing or invalid auth token');
      return res.status(401).json({
        success: false,
        error: 'Unauthorized. Admin authentication required.'
      });
    }
    
    const { poolAddress, poolData } = req.body;
    console.log('Pool address:', poolAddress);
    console.log('Pool data:', poolData ? 'Provided' : 'Not provided');
    
    if (!poolAddress) {
      return res.status(400).json({
        success: false,
        error: 'Pool address is required'
      });
    }
    
    console.log('Starting fee claim process...');
    // Claim fees from the specified pool
    const result = await claimPoolFees(poolAddress, poolData || {});
    
    console.log('Claim result:', result.success ? 'SUCCESS' : 'FAILED');
    if (!result.success) {
      console.error('Claim failed:', result.error);
    }
    
    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }
    
  } catch (error) {
    console.error('====== ERROR IN CLAIM ENDPOINT ======');
    console.error('Error:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      details: error.toString()
    });
  }
});

// Get pool fee metrics endpoint
app.get('/api/pool-fees/:poolAddress', async (req, res) => {
  try {
    const { poolAddress } = req.params;
    
    if (!poolAddress) {
      return res.status(400).json({
        success: false,
        error: 'Pool address is required'
      });
    }
    
    // Get fee metrics for the pool
    const result = await getPoolFeeMetrics(poolAddress);
    
    res.status(200).json(result);
    
  } catch (error) {
    console.error('Error in /api/pool-fees:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Verify PIN endpoint for admin pages
app.post('/api/verify-pin', async (req, res) => {
  try {
    const { pin } = req.body;
    
    if (!pin) {
      return res.status(400).json({
        success: false,
        error: 'PIN is required'
      });
    }
    
    // Get the PIN from environment variable
    const correctPin = process.env.four_pin || process.env.FOUR_PIN;
    
    if (!correctPin) {
      console.error('four_pin environment variable not set');
      return res.status(500).json({
        success: false,
        error: 'PIN verification not configured'
      });
    }
    
    // Verify PIN
    if (pin === correctPin) {
      res.status(200).json({
        success: true,
        message: 'PIN verified successfully'
      });
    } else {
      res.status(401).json({
        success: false,
        error: 'Invalid PIN'
      });
    }
    
  } catch (error) {
    console.error('Error in /api/verify-pin:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Claim creator fees from a single pool
// Health check endpoint for RPC connectivity
app.get('/api/health/rpc', async (req, res) => {
  try {
    const { Connection } = require('@solana/web3.js');
    const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "726140d8-6b0d-4719-8702-682d81e94a37";
    const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
    const FALLBACK_RPC = "https://api.mainnet-beta.solana.com";
    
    const results = {};
    
    // Test Helius RPC
    try {
      const heliusConnection = new Connection(RPC_URL, 'confirmed');
      const heliusStart = Date.now();
      const heliusBlockhash = await heliusConnection.getLatestBlockhash('confirmed');
      results.helius = {
        status: 'healthy',
        latency: Date.now() - heliusStart,
        blockhash: heliusBlockhash.blockhash.substring(0, 8) + '...'
      };
    } catch (error) {
      results.helius = {
        status: 'unhealthy',
        error: error.message
      };
    }
    
    // Test fallback RPC
    try {
      const fallbackConnection = new Connection(FALLBACK_RPC, 'confirmed');
      const fallbackStart = Date.now();
      const fallbackBlockhash = await fallbackConnection.getLatestBlockhash('confirmed');
      results.fallback = {
        status: 'healthy',
        latency: Date.now() - fallbackStart,
        blockhash: fallbackBlockhash.blockhash.substring(0, 8) + '...'
      };
    } catch (error) {
      results.fallback = {
        status: 'unhealthy',
        error: error.message
      };
    }
    
    const allHealthy = results.helius.status === 'healthy' || results.fallback.status === 'healthy';
    
    res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      rpcEndpoints: results
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

app.post('/api/claim-creator-fees', async (req, res) => {
  try {
    console.log('====== CLAIM CREATOR FEES ENDPOINT ======');
    const { poolAddress, userId, creatorPrivateKey, signedTxBase64 } = req.body;
    if (!poolAddress || !userId) {
      return res.status(400).json({ success: false, error: 'Pool address and user ID are required' });
    }

    // Initialize Supabase (for DB lookup and logging)
    const { createClient } = require('@supabase/supabase-js');
    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

    // Broadcast mode (client provided a signed tx)
    if (signedTxBase64) {
      if (!HELIUS_RPC) {
        return res.status(500).json({ success: false, error: 'HELIUS_API_KEY not configured' });
      }
      const { Connection } = require('@solana/web3.js');
      const connection = new Connection(HELIUS_RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60000 });
      await connection.getLatestBlockhash('confirmed');
      const broadcast = await broadcastSignedClaimTx({ connection, supabaseClient: supabaseAdmin, poolAddress, userId, signedTxBase64 });
      return res.status(200).json({ success: true, transactionSignature: broadcast.signature, solscanUrl: `https://solscan.io/tx/${broadcast.signature}` });
    }

    // Legacy mode (temporary support) if private key provided
    if (creatorPrivateKey) {
      const legacy = await claimCreatorFees(poolAddress, creatorPrivateKey, userId);
      const code = legacy.success ? 200 : 500;
      return res.status(code).json(legacy);
    }

    // Prepare mode: build unsigned tx for user to sign with Privy
    // Lookup user's Privy wallet address from DB
    const { data: userRow, error: userErr } = await supabaseAdmin
      .from('users')
      .select('wallet_address')
      .eq('id', userId)
      .single();
    if (userErr || !userRow?.wallet_address) {
      return res.status(400).json({ success: false, error: 'User wallet not found' });
    }

    if (!HELIUS_RPC) {
      return res.status(500).json({ success: false, error: 'HELIUS_API_KEY not configured' });
    }
    const { Connection } = require('@solana/web3.js');
    const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
    const connection = new Connection(HELIUS_RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60000 });
    await connection.getLatestBlockhash('confirmed');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');

    const { PublicKey } = require('@solana/web3.js');
    const poolPubkey = new PublicKey(poolAddress);
    const userWalletPubkey = new PublicKey(userRow.wallet_address);

    // Check fee metrics and migration
    let feeMetrics;
    try {
      feeMetrics = await dbcClient.state.getPoolFeeMetrics(poolPubkey);
    } catch (e) {
      feeMetrics = null;
    }

    if (feeMetrics && feeMetrics.current && (!feeMetrics.current.creatorBaseFee.isZero() || !feeMetrics.current.creatorQuoteFee.isZero())) {
      const tx = await prepareCreatorClaimTxDBC({ connection, dbcClient, poolPubkey, userWalletPubkey, feeMetrics });
      const txBase64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
      return res.status(200).json({ success: true, needsSignature: true, transactions: [txBase64] });
    }

    // If no fees on DBC, check migration to DAMM v2
    const migration = await checkPoolMigrationOfficial(poolAddress, connection);
    if (migration.migrated && migration.dammVersion === 'v2') {
      const migratedPoolAddress = await getMigratedPoolAddress(poolAddress, connection, 'v2');
      const txs = await prepareCreatorClaimTxDammV2({ connection, migratedPoolAddress: migratedPoolAddress.toString(), userWalletPubkey });
      if (txs.length === 0) {
        return res.status(400).json({ success: false, error: 'No positions found to claim' });
      }
      const base64s = txs.map(tx => tx.serialize({ requireAllSignatures: false }).toString('base64'));
      return res.status(200).json({ success: true, needsSignature: true, transactions: base64s, migrated: true, dammVersion: 'v2', newPoolAddress: migratedPoolAddress.toString() });
    }

    return res.status(400).json({ success: false, error: 'No creator fees available to claim' });
  } catch (error) {
    console.error('====== ERROR IN CREATOR CLAIM ENDPOINT ======');
    console.error('Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

// Claim all creator fees for a user
app.post('/api/claim-all-creator-fees', async (req, res) => {
  try {
    console.log('====== CLAIM ALL CREATOR FEES ENDPOINT ======');
    
    const { userId, creatorPrivateKey } = req.body;
    
    if (!userId || !creatorPrivateKey) {
      return res.status(400).json({
        success: false,
        error: 'User ID and creator private key are required'
      });
    }
    
    console.log('Starting claim all process for user:', userId);
    const result = await claimAllCreatorFees(userId, creatorPrivateKey);
    
    console.log('Claim all result:', result.success ? 'SUCCESS' : 'FAILED');
    
    if (result.success || result.poolsProcessed > 0) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }
    
  } catch (error) {
    console.error('====== ERROR IN CLAIM ALL ENDPOINT ======');
    console.error('Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Check available creator fees for a pool
app.get('/api/creator-fees/:poolAddress', async (req, res) => {
  try {
    const { poolAddress } = req.params;
    
    if (!poolAddress) {
      return res.status(400).json({
        success: false,
        error: 'Pool address is required'
      });
    }
    
    const result = await checkAvailableCreatorFees(poolAddress);
    res.status(200).json(result);
    
  } catch (error) {
    console.error('Error in /api/creator-fees:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Webhook endpoint removed - using DBC SDK polling instead

// Setup webhook for a pool
app.post('/api/webhooks/setup', async (req, res) => {
  try {
    console.log('Setting up webhook for pool...');
    
    const { poolAddress, postId } = req.body;
    
    if (!poolAddress) {
      return res.status(400).json({
        success: false,
        error: 'Pool address is required'
      });
    }
    
    const result = await setupPoolWebhook(poolAddress, postId);
    
    res.status(200).json({
      success: true,
      webhookId: result.webhookID,
      poolAddress
    });
    
  } catch (error) {
    console.error('Error setting up webhook:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to setup webhook'
    });
  }
});

// List all active webhooks
app.get('/api/webhooks/list', async (req, res) => {
  try {
    // Verify admin auth
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${process.env.ADMIN_AUTH_TOKEN || 'admin-secret'}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const webhooks = await listWebhooks();
    res.status(200).json({ success: true, webhooks });
    
  } catch (error) {
    console.error('Error listing webhooks:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to list webhooks'
    });
  }
});

// Test endpoint for checking pool migration status
app.get('/api/pool-migration-status/:poolAddress', async (req, res) => {
  try {
    const { poolAddress } = req.params;
    const { checkPoolMigration } = require('./checkPoolMigration');
    
    console.log('Checking migration status for pool:', poolAddress);
    const migrationStatus = await checkPoolMigration(poolAddress);
    
    res.status(200).json({
      success: true,
      ...migrationStatus
    });
    
  } catch (error) {
    console.error('Error checking migration status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check migration status'
    });
  }
});

// Sync all-time fees for all pools
app.post('/api/fees/sync-all', async (req, res) => {
  try {
    console.log('====== SYNCING ALL-TIME FEES ======');
    
    await syncAllTimeFees();
    
    res.status(200).json({
      success: true,
      message: 'Fee sync completed'
    });
    
  } catch (error) {
    console.error('Error syncing fees:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to sync fees'
    });
  }
});

// Get lifetime fees for specific pool using DBC SDK
app.get('/api/fees/lifetime/:poolAddress', async (req, res) => {
  try {
    const { poolAddress } = req.params;
    
    console.log(`Getting lifetime fees for pool: ${poolAddress}`);
    
    const result = await getLifetimeFees(poolAddress);
    
    res.status(200).json(result);
    
  } catch (error) {
    console.error('Error getting lifetime fees:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get fees'
    });
  }
});

// Update post endpoint removed - updates happen in getLifetimeFees.js instead

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: 'Something went wrong!'
  });
});

// Test keypair worker endpoint
app.get('/api/test-keypair-worker', async (req, res) => {
  console.log('\n🔧 TEST KEYPAIR WORKER ENDPOINT CALLED');
  
  try {
    // Test Supabase connection
    console.log('Testing Supabase connection...');
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );
    
    // Try to count keypairs
    const { count, error: countError } = await supabase
      .from('keypairs')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('❌ Supabase count error:', countError);
      return res.status(500).json({
        success: false,
        error: 'Database connection failed',
        details: countError
      });
    }
    
    console.log(`✅ Database connected! Current keypair count: ${count}`);
    
    // Try to generate and insert one keypair
    console.log('Generating test keypair...');
    const { Keypair } = require('@solana/web3.js');
    const bs58 = require('bs58').default;
    
    const keypair = Keypair.generate();
    const testKeypair = {
      public_key: keypair.publicKey.toBase58(),
      secret_key: bs58.encode(keypair.secretKey),
      has_vanity_suffix: false,
      vanity_suffix: null
    };
    
    console.log('Inserting test keypair:', testKeypair.public_key);
    
    const { data, error } = await supabase
      .from('keypairs')
      .insert([testKeypair])
      .select();
    
    if (error) {
      console.error('❌ Insert error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to insert keypair',
        details: error
      });
    }
    
    console.log('✅ Test keypair inserted successfully!');
    
    res.json({
      success: true,
      message: 'Keypair worker test successful',
      currentCount: count,
      testKeypair: testKeypair.public_key,
      inserted: data
    });
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Daily Bugle Token Launch Endpoint
app.post('/api/daily-bugle-launch', async (req, res) => {
  try {
    console.log('=== DAILY BUGLE LAUNCH ===');
    console.log('Request from:', req.headers.origin || 'Unknown origin');
    console.log('Authorization:', req.headers.authorization ? 'Present' : 'Missing');
    
    // Check for auth token
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.DAILY_BUGLE_AUTH_TOKEN || 'bugle-secret-2024';
    
    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
      console.error('Unauthorized Daily Bugle launch attempt');
      return res.status(401).json({
        success: false,
        error: 'Unauthorized. Daily Bugle auth token required.'
      });
    }
    
    // Import and execute the Daily Bugle launcher
    const { launchDailyBugleToken } = require('./dailyBugleLaunch');
    
    console.log('Launching Daily Bugle token...');
    const result = await launchDailyBugleToken();
    
    if (result.success) {
      console.log('✅ Daily Bugle token launched successfully!');
      res.status(200).json(result);
    } else {
      console.error('❌ Daily Bugle launch failed:', result.error);
      res.status(500).json(result);
    }
    
  } catch (error) {
    console.error('Error in /api/daily-bugle-launch:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Inkwell backend server running on port ${PORT}`);
  console.log(`Config address: ${process.env.DBC_CONFIG_PUBKEY}`);
  console.log(`RPC endpoint: https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY?.substring(0, 8)}...`);
  
  // DISABLED: Periodic fee sync - now using manual refresh only
  // console.log('Starting periodic lifetime fee sync job...');
  // setInterval(async () => {
  //   console.log('[CRON] Running lifetime fee sync...');
  //   try {
  //     await updateAllPoolsLifetimeFees();
  //     console.log('[CRON] Lifetime fee sync completed');
  //   } catch (error) {
  //     console.error('[CRON] Lifetime fee sync error:', error);
  //   }
  // }, 5 * 60 * 1000); // 5 minutes
  
  // // Run initial sync after 10 seconds
  // setTimeout(async () => {
  //   console.log('[STARTUP] Running initial lifetime fee sync...');
  //   try {
  //     await updateAllPoolsLifetimeFees();
  //     console.log('[STARTUP] Initial lifetime fee sync completed');
  //   } catch (error) {
  //     console.error('[STARTUP] Initial lifetime fee sync error:', error);
  //   }
  // }, 10000);
});

module.exports = app;
