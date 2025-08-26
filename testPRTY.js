// Test finding PRTY (4 character suffix)
const { Keypair } = require('@solana/web3.js');

console.log('=== TESTING "PRTY" VANITY GENERATION ===\n');

// Calculate probability
const probability4 = 1 / Math.pow(58, 4);
const probability5 = 1 / Math.pow(58, 5);

console.log(`📊 Probability comparison:`);
console.log(`   "PRTY" (4 chars): 1 in ${Math.pow(58, 4).toLocaleString()} (~${(probability4 * 100).toFixed(5)}%)`);
console.log(`   "PARTY" (5 chars): 1 in ${Math.pow(58, 5).toLocaleString()} (~${(probability5 * 100).toFixed(7)}%)`);
console.log(`   Speedup: ${Math.pow(58, 5) / Math.pow(58, 4)}x faster (58x)!\n`);

async function findPRTY() {
  const startTime = Date.now();
  let attempts = 0;
  
  console.log('🔍 Searching for address ending with "PRTY"...\n');
  
  while (true) {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    attempts++;
    
    // Check case-insensitive
    if (address.toLowerCase().endsWith('prty')) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`\n🎉 FOUND MATCH!`);
      console.log(`   Address: ${address}`);
      console.log(`   Exact match "PRTY": ${address.endsWith('PRTY')}`);
      console.log(`   Attempts: ${attempts.toLocaleString()}`);
      console.log(`   Time: ${elapsed.toFixed(2)} seconds`);
      console.log(`   Rate: ${Math.floor(attempts / elapsed).toLocaleString()} addresses/second`);
      
      // If we found multiple in reasonable time, keep going
      if (elapsed < 60) {
        console.log('\n🔍 Searching for another one...');
        continue;
      }
      break;
    }
    
    // Progress update
    if (attempts % 100000 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`⏳ Progress: ${attempts.toLocaleString()} attempts (${elapsed.toFixed(1)}s)`);
    }
  }
}

findPRTY().catch(console.error);