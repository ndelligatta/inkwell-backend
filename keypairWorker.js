// Background worker for continuous keypair generation
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client with service role key
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Configuration
const CONFIG = {
  TARGET_POOL_SIZE: parseInt(process.env.KEYPAIR_POOL_SIZE) || 100,
  BATCH_SIZE: parseInt(process.env.KEYPAIR_BATCH_SIZE) || 10,
  CHECK_INTERVAL_MS: parseInt(process.env.CHECK_INTERVAL_MS) || 5000,
  VANITY_SUFFIX: 'PARTY',
  VANITY_TIMEOUT_MS: 10000, // 10 seconds per vanity attempt
  VANITY_RATIO: 0.3, // Try to maintain 30% vanity keypairs
};

class KeypairWorker {
  constructor() {
    this.isRunning = false;
    this.stats = {
      generated: 0,
      vanityGenerated: 0,
      errors: 0,
      startTime: Date.now()
    };
  }

  async start() {
    console.log('=== KEYPAIR WORKER STARTED ===');
    console.log(`Target pool size: ${CONFIG.TARGET_POOL_SIZE}`);
    console.log(`Batch size: ${CONFIG.BATCH_SIZE}`);
    console.log(`Vanity suffix: ${CONFIG.VANITY_SUFFIX}`);
    console.log(`Vanity ratio target: ${CONFIG.VANITY_RATIO * 100}%`);
    
    this.isRunning = true;
    
    // Set up graceful shutdown
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
    
    // Start the worker loop
    await this.workerLoop();
  }

  async stop() {
    console.log('\n=== SHUTTING DOWN KEYPAIR WORKER ===');
    this.isRunning = false;
    this.printStats();
    process.exit(0);
  }

  printStats() {
    const runtime = (Date.now() - this.stats.startTime) / 1000;
    console.log('\n=== WORKER STATISTICS ===');
    console.log(`Runtime: ${runtime.toFixed(2)} seconds`);
    console.log(`Total generated: ${this.stats.generated}`);
    console.log(`Vanity generated: ${this.stats.vanityGenerated}`);
    console.log(`Errors: ${this.stats.errors}`);
    console.log(`Generation rate: ${(this.stats.generated / runtime).toFixed(2)} keypairs/second`);
  }

  async workerLoop() {
    while (this.isRunning) {
      try {
        // Check current pool status
        const poolStatus = await this.getPoolStatus();
        console.log(`\n[${new Date().toISOString()}] Pool status:`, poolStatus);
        
        if (poolStatus.total < CONFIG.TARGET_POOL_SIZE) {
          const needed = CONFIG.TARGET_POOL_SIZE - poolStatus.total;
          const batchSize = Math.min(needed, CONFIG.BATCH_SIZE);
          
          console.log(`Generating ${batchSize} keypairs...`);
          await this.generateBatch(batchSize, poolStatus);
        } else {
          console.log('Pool is full, waiting...');
        }
        
        // Print stats every 10 iterations
        if (this.stats.generated % 100 === 0 && this.stats.generated > 0) {
          this.printStats();
        }
        
        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, CONFIG.CHECK_INTERVAL_MS));
        
      } catch (error) {
        console.error('Worker loop error:', error);
        this.stats.errors++;
        // Wait longer on error
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }

  async getPoolStatus() {
    const { data, error } = await supabase
      .from('keypairs')
      .select('has_vanity_suffix', { count: 'exact' });
    
    if (error) throw error;
    
    const total = data?.length || 0;
    const vanityCount = data?.filter(k => k.has_vanity_suffix).length || 0;
    const regularCount = total - vanityCount;
    
    return {
      total,
      vanityCount,
      regularCount,
      vanityRatio: total > 0 ? vanityCount / total : 0
    };
  }

  async generateBatch(batchSize, poolStatus) {
    const keypairs = [];
    
    // Determine how many vanity keypairs to generate
    const needMoreVanity = poolStatus.vanityRatio < CONFIG.VANITY_RATIO;
    const vanityCount = needMoreVanity ? Math.ceil(batchSize * 0.5) : 0;
    const regularCount = batchSize - vanityCount;
    
    console.log(`Generating ${vanityCount} vanity and ${regularCount} regular keypairs...`);
    
    // Generate vanity keypairs
    for (let i = 0; i < vanityCount; i++) {
      try {
        const keypair = await this.generateVanityKeypair();
        if (keypair) {
          keypairs.push(keypair);
          this.stats.vanityGenerated++;
        }
      } catch (error) {
        console.error('Vanity generation error:', error);
        // Fall back to regular keypair
        const regularKeypair = this.generateRegularKeypair();
        keypairs.push(regularKeypair);
      }
      this.stats.generated++;
    }
    
    // Generate regular keypairs
    for (let i = 0; i < regularCount; i++) {
      const keypair = this.generateRegularKeypair();
      keypairs.push(keypair);
      this.stats.generated++;
    }
    
    // Bulk insert to database
    if (keypairs.length > 0) {
      await this.insertKeypairs(keypairs);
      console.log(`Inserted ${keypairs.length} keypairs to database`);
    }
  }

  generateRegularKeypair() {
    const keypair = Keypair.generate();
    return {
      public_key: keypair.publicKey.toBase58(),
      secret_key: bs58.encode(keypair.secretKey),
      has_vanity_suffix: false,
      vanity_suffix: null
    };
  }

  async generateVanityKeypair() {
    const startTime = Date.now();
    const checkSuffix = CONFIG.VANITY_SUFFIX.toLowerCase();
    let attempts = 0;
    
    console.log(`Searching for address ending with "${CONFIG.VANITY_SUFFIX}"...`);
    
    while (Date.now() - startTime < CONFIG.VANITY_TIMEOUT_MS) {
      const keypair = Keypair.generate();
      const address = keypair.publicKey.toBase58();
      attempts++;
      
      // Case-insensitive check
      if (address.toLowerCase().endsWith(checkSuffix)) {
        console.log(`Found vanity address after ${attempts} attempts: ${address}`);
        return {
          public_key: address,
          secret_key: bs58.encode(keypair.secretKey),
          has_vanity_suffix: true,
          vanity_suffix: CONFIG.VANITY_SUFFIX
        };
      }
      
      // Yield to event loop periodically
      if (attempts % 1000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    
    console.log(`Vanity generation timeout after ${attempts} attempts`);
    // Return regular keypair if timeout
    return this.generateRegularKeypair();
  }

  async insertKeypairs(keypairs) {
    const { error } = await supabase
      .from('keypairs')
      .insert(keypairs);
    
    if (error) {
      console.error('Database insert error:', error);
      throw error;
    }
  }
}

// Start the worker
const worker = new KeypairWorker();
worker.start().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});