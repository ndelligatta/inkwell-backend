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
const { launchTokenDBC, getUserDevWallet, validateMetadata } = require('./tokenLauncherImproved');
const { createInkwellConfig } = require('./createConfig');
const { claimPoolFees, getPoolFeeMetrics } = require('./claimPlatformFees');

const app = express();
const PORT = process.env.PORT || 3001;

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

    // Prepare metadata
    const metadata = {
      name: name.trim(),
      symbol: symbol.trim(),
      description: description?.trim() || '',
      website: website?.trim(),
      twitter: twitter?.trim(),
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: 'Something went wrong!'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Inkwell backend server running on port ${PORT}`);
  console.log(`Config address: ${process.env.DBC_CONFIG_PUBKEY}`);
  console.log(`RPC endpoint: https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY?.substring(0, 8)}...`);
});

module.exports = app;