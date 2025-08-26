// Test the keypair worker locally without database
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default;

console.log('\n🚀 =================================');
console.log('🚀 KEYPAIR WORKER TEST (NO DATABASE)');
console.log('🚀 =================================');
console.log(`✨ Vanity suffix: "PRTY"`);
console.log(`🎯 Generating batch of 5 keypairs`);
console.log('🚀 =================================\n');

async function generateVanityKeypair() {
  const startTime = Date.now();
  const checkSuffix = 'prty';
  let attempts = 0;
  
  console.log(`   🔍 Searching for address ending with "PRTY"...`);
  
  while (Date.now() - startTime < 60000) { // 60 second timeout
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    attempts++;
    
    // Case-insensitive check
    if (address.toLowerCase().endsWith(checkSuffix)) {
      console.log(`   🎉 FOUND VANITY ADDRESS after ${attempts.toLocaleString()} attempts!`);
      return {
        public_key: address,
        secret_key: bs58.encode(keypair.secretKey),
        has_vanity_suffix: true,
        vanity_suffix: 'PRTY'
      };
    }
    
    // Progress update
    if (attempts % 50000 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`   ⏳ Progress: ${attempts.toLocaleString()} attempts (${elapsed.toFixed(1)}s)...`);
    }
  }
  
  console.log(`   ⏱️ Timeout after ${attempts.toLocaleString()} attempts`);
  // Return regular keypair
  const keypair = Keypair.generate();
  return {
    public_key: keypair.publicKey.toBase58(),
    secret_key: bs58.encode(keypair.secretKey),
    has_vanity_suffix: false,
    vanity_suffix: null
  };
}

function generateRegularKeypair() {
  const keypair = Keypair.generate();
  return {
    public_key: keypair.publicKey.toBase58(),
    secret_key: bs58.encode(keypair.secretKey),
    has_vanity_suffix: false,
    vanity_suffix: null
  };
}

async function generateBatch() {
  console.log('🔨 GENERATING BATCH...\n');
  
  const keypairs = [];
  
  // Try to generate 2 vanity keypairs
  for (let i = 0; i < 2; i++) {
    console.log(`🎯 Generating vanity keypair ${i + 1}/2...`);
    const keypair = await generateVanityKeypair();
    keypairs.push(keypair);
    console.log(`   ✅ ${keypair.has_vanity_suffix ? 'VANITY' : 'Regular (timeout)'} keypair: ${keypair.public_key}\n`);
  }
  
  // Generate 3 regular keypairs
  for (let i = 0; i < 3; i++) {
    console.log(`⚡ Generating regular keypair ${i + 1}/3...`);
    const keypair = generateRegularKeypair();
    keypairs.push(keypair);
    console.log(`   ✅ Regular keypair: ${keypair.public_key}`);
  }
  
  console.log('\n📊 BATCH COMPLETE!');
  console.log('=================================');
  console.log('📋 Generated Keypairs:');
  keypairs.forEach((kp, i) => {
    if (kp.has_vanity_suffix) {
      console.log(`   ${i + 1}. ${kp.public_key} ✨ <-- ENDS WITH PRTY!`);
    } else {
      console.log(`   ${i + 1}. ${kp.public_key}`);
    }
  });
  
  // Show the vanity ones clearly
  const vanityKeypairs = keypairs.filter(k => k.has_vanity_suffix);
  if (vanityKeypairs.length > 0) {
    console.log('\n🎉 VANITY KEYPAIRS FOUND:');
    vanityKeypairs.forEach(kp => {
      console.log(`   ✨ ${kp.public_key}`);
      console.log(`      Last 4 chars: "${kp.public_key.slice(-4)}"`);
    });
  }
  
  console.log('\n✅ These would be inserted into the database!');
  console.log('=================================\n');
}

// Run the test
generateBatch().catch(console.error);