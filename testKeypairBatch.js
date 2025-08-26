// Test keypair batch generation without database
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default;

console.log('=== KEYPAIR BATCH GENERATION TEST ===\n');

// Configuration
const CONFIG = {
  VANITY_SUFFIX: 'PARTY',
  VANITY_TIMEOUT_MS: 10000, // 10 seconds per vanity attempt
};

function generateRegularKeypair() {
  const keypair = Keypair.generate();
  return {
    public_key: keypair.publicKey.toBase58(),
    secret_key: bs58.encode(keypair.secretKey),
    has_vanity_suffix: false,
    vanity_suffix: null
  };
}

async function generateVanityKeypair() {
  const startTime = Date.now();
  const checkSuffix = CONFIG.VANITY_SUFFIX.toLowerCase();
  let attempts = 0;
  
  console.log(`   🔍 Searching for address ending with "${CONFIG.VANITY_SUFFIX}"...`);
  
  while (Date.now() - startTime < CONFIG.VANITY_TIMEOUT_MS) {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    attempts++;
    
    // Case-insensitive check
    if (address.toLowerCase().endsWith(checkSuffix)) {
      console.log(`   🎉 Found vanity address after ${attempts.toLocaleString()} attempts!`);
      return {
        public_key: address,
        secret_key: bs58.encode(keypair.secretKey),
        has_vanity_suffix: true,
        vanity_suffix: CONFIG.VANITY_SUFFIX
      };
    }
    
    // Progress update
    if (attempts % 10000 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`   ⏳ Progress: ${attempts.toLocaleString()} attempts (${elapsed.toFixed(1)}s elapsed)...`);
    }
    
    // Yield to event loop periodically
    if (attempts % 1000 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  
  console.log(`   ⏱️ Timeout after ${attempts.toLocaleString()} attempts`);
  // Return regular keypair if timeout
  return generateRegularKeypair();
}

async function generateBatch() {
  console.log('🔨 =================================');
  console.log('🔨 KEYPAIR GENERATION BATCH STARTING');
  console.log('🔨 =================================');
  
  const batchSize = 5;
  const vanityCount = 2;
  const regularCount = 3;
  
  console.log(`📊 Batch details:`);
  console.log(`   - Total to generate: ${batchSize}`);
  console.log(`   - Vanity keypairs: ${vanityCount}`);
  console.log(`   - Regular keypairs: ${regularCount}`);
  console.log('🔨 =================================\n');
  
  const keypairs = [];
  
  // Generate vanity keypairs
  for (let i = 0; i < vanityCount; i++) {
    console.log(`🎯 Generating vanity keypair ${i + 1}/${vanityCount}...`);
    try {
      const keypair = await generateVanityKeypair();
      keypairs.push(keypair);
      console.log(`   ✅ ${keypair.has_vanity_suffix ? 'Vanity' : 'Regular (timeout)'} keypair generated: ${keypair.public_key}`);
    } catch (error) {
      console.error('   ❌ Error:', error.message);
    }
  }
  
  // Generate regular keypairs
  for (let i = 0; i < regularCount; i++) {
    console.log(`⚡ Generating regular keypair ${i + 1}/${regularCount}...`);
    const keypair = generateRegularKeypair();
    keypairs.push(keypair);
    console.log(`   ✅ Regular keypair generated: ${keypair.public_key}`);
  }
  
  console.log('\n📊 Batch Summary:');
  console.log(`   Total generated: ${keypairs.length}`);
  console.log(`   Vanity keypairs: ${keypairs.filter(k => k.has_vanity_suffix).length}`);
  console.log(`   Regular keypairs: ${keypairs.filter(k => !k.has_vanity_suffix).length}`);
  
  console.log('\n📋 Generated Keypairs:');
  keypairs.forEach((kp, i) => {
    console.log(`   ${i + 1}. ${kp.public_key} ${kp.has_vanity_suffix ? '✨ (VANITY)' : ''}`);
  });
  
  // Verify reconstruction
  console.log('\n🔧 Verifying keypair reconstruction:');
  const testKeypair = keypairs[0];
  try {
    const reconstructed = Keypair.fromSecretKey(bs58.decode(testKeypair.secret_key));
    const matches = reconstructed.publicKey.toBase58() === testKeypair.public_key;
    console.log(`   ${matches ? '✅' : '❌'} Keypair reconstruction ${matches ? 'successful' : 'failed'}`);
  } catch (error) {
    console.error('   ❌ Reconstruction error:', error.message);
  }
}

// Run the test
generateBatch().catch(console.error);