// Dedicated test to find PARTY vanity address
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default;

console.log('=== SEARCHING FOR "PARTY" VANITY ADDRESS ===\n');

// Calculate probability
const probability = 1 / Math.pow(58, 5);
console.log(`📊 Statistics:`);
console.log(`   Pattern: "PARTY" (5 characters)`);
console.log(`   Probability: 1 in ${Math.pow(58, 5).toLocaleString()}`);
console.log(`   Expected attempts: ~${(1/probability).toLocaleString()}`);
console.log(`\n🚀 Starting search...\n`);

async function findPartyAddress(timeoutMinutes = 5) {
  const startTime = Date.now();
  const timeoutMs = timeoutMinutes * 60 * 1000;
  let attempts = 0;
  let lastReportTime = startTime;
  
  while (Date.now() - startTime < timeoutMs) {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    attempts++;
    
    // Check case-insensitive first (much easier)
    if (address.toLowerCase().endsWith('party')) {
      const exactMatch = address.endsWith('PARTY');
      console.log(`\n🎉 FOUND ${exactMatch ? 'EXACT' : 'CASE-INSENSITIVE'} MATCH!`);
      console.log(`   Address: ${address}`);
      console.log(`   Attempts: ${attempts.toLocaleString()}`);
      console.log(`   Time: ${((Date.now() - startTime) / 1000).toFixed(2)} seconds`);
      console.log(`   Rate: ${Math.floor(attempts / ((Date.now() - startTime) / 1000)).toLocaleString()} addresses/second`);
      
      // Save the keypair
      const result = {
        public_key: address,
        secret_key: bs58.encode(keypair.secretKey),
        has_vanity_suffix: true,
        vanity_suffix: 'PARTY',
        exact_match: exactMatch
      };
      
      console.log(`\n💾 Keypair data:`);
      console.log(`   Public key: ${result.public_key}`);
      console.log(`   Secret key length: ${result.secret_key.length} characters`);
      console.log(`   Ends with "PARTY": ${address.endsWith('PARTY')}`);
      console.log(`   Ends with "party" (case-insensitive): ${address.toLowerCase().endsWith('party')}`);
      
      return result;
    }
    
    // Progress report every 5 seconds
    if (Date.now() - lastReportTime > 5000) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = attempts / elapsed;
      const progress = (attempts / (1/probability)) * 100;
      
      console.log(`⏳ Progress: ${attempts.toLocaleString()} attempts | ${elapsed.toFixed(1)}s | ${rate.toFixed(0)} addr/sec | ~${progress.toFixed(4)}% expected`);
      lastReportTime = Date.now();
    }
    
    // Yield to event loop
    if (attempts % 1000 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  
  console.log(`\n⏱️ Timeout reached after ${timeoutMinutes} minutes`);
  console.log(`   Total attempts: ${attempts.toLocaleString()}`);
  console.log(`   Average rate: ${Math.floor(attempts / ((Date.now() - startTime) / 1000)).toLocaleString()} addresses/second`);
  return null;
}

// Try to find one with a longer timeout
console.log(`🔍 Searching for up to 5 minutes...\n`);
findPartyAddress(5).then(result => {
  if (result) {
    console.log('\n✅ SUCCESS! Found a vanity address ending with "party"');
    
    // Test reconstruction
    console.log('\n🔧 Verifying keypair reconstruction...');
    try {
      const reconstructed = Keypair.fromSecretKey(bs58.decode(result.secret_key));
      const matches = reconstructed.publicKey.toBase58() === result.public_key;
      console.log(`   ${matches ? '✅' : '❌'} Reconstruction ${matches ? 'successful' : 'failed'}`);
    } catch (error) {
      console.error('   ❌ Reconstruction error:', error.message);
    }
  } else {
    console.log('\n❌ No vanity address found within timeout');
    console.log('💡 Tip: "PARTY" is extremely rare. Consider:');
    console.log('   - Using case-insensitive matching');
    console.log('   - Running the worker service continuously');
    console.log('   - Using shorter suffixes like "PTY" or "ARY"');
  }
}).catch(console.error);