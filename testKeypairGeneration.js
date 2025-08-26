// Test keypair generation functionality
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default;

console.log('=== KEYPAIR GENERATION TEST ===\n');

// Test 1: Generate regular keypair
console.log('1. Testing regular keypair generation:');
try {
  const regularKeypair = Keypair.generate();
  const publicKey = regularKeypair.publicKey.toBase58();
  const secretKey = bs58.encode(regularKeypair.secretKey);
  
  console.log('   ✅ Generated regular keypair');
  console.log('   Public Key:', publicKey);
  console.log('   Public Key Length:', publicKey.length);
  console.log('   Secret Key (base58) Length:', secretKey.length);
  
  // Verify we can reconstruct the keypair
  const reconstructed = Keypair.fromSecretKey(bs58.decode(secretKey));
  console.log('   ✅ Reconstructed keypair successfully');
  console.log('   Matches:', reconstructed.publicKey.toBase58() === publicKey);
} catch (error) {
  console.error('   ❌ Error:', error.message);
}

// Test 2: Generate vanity keypair
console.log('\n2. Testing vanity keypair generation (suffix "XY"):');
const startTime = Date.now();
let attempts = 0;
let found = false;

while (!found && attempts < 100000) {
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();
  attempts++;
  
  if (address.toLowerCase().endsWith('xy')) {
    console.log('   ✅ Found vanity address after', attempts, 'attempts');
    console.log('   Address:', address);
    console.log('   Time:', ((Date.now() - startTime) / 1000).toFixed(2), 'seconds');
    console.log('   Rate:', Math.floor(attempts / ((Date.now() - startTime) / 1000)), 'addresses/second');
    found = true;
  }
}

if (!found) {
  console.log('   ⚠️ No vanity address found after', attempts, 'attempts');
}

// Test 3: Check generation rate
console.log('\n3. Testing generation rate (5 seconds):');
const rateStart = Date.now();
let count = 0;

while (Date.now() - rateStart < 5000) {
  Keypair.generate();
  count++;
}

const elapsed = (Date.now() - rateStart) / 1000;
console.log('   Generated:', count.toLocaleString(), 'keypairs');
console.log('   Time:', elapsed.toFixed(2), 'seconds');
console.log('   Rate:', Math.floor(count / elapsed).toLocaleString(), 'keypairs/second');

// Test 4: Vanity search for "PARTY"
console.log('\n4. Testing vanity search for "PARTY" (10 second timeout):');
const partyStart = Date.now();
let partyAttempts = 0;
let partyFound = false;

while (Date.now() - partyStart < 10000 && !partyFound) {
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();
  partyAttempts++;
  
  // Case-insensitive search
  if (address.toLowerCase().endsWith('party')) {
    console.log('   ✅ Found vanity address!');
    console.log('   Address:', address);
    console.log('   Attempts:', partyAttempts.toLocaleString());
    console.log('   Time:', ((Date.now() - partyStart) / 1000).toFixed(2), 'seconds');
    partyFound = true;
  }
  
  // Progress update
  if (partyAttempts % 100000 === 0) {
    console.log('   Progress:', partyAttempts.toLocaleString(), 'attempts...');
  }
}

if (!partyFound) {
  console.log('   ⏱️ Timeout - no "PARTY" address found after', partyAttempts.toLocaleString(), 'attempts');
  const rate = partyAttempts / ((Date.now() - partyStart) / 1000);
  console.log('   Rate:', Math.floor(rate).toLocaleString(), 'addresses/second');
  
  // Estimate time for 5-character pattern
  const probability = 1 / Math.pow(58, 5);
  const expectedAttempts = 1 / probability;
  const estimatedSeconds = expectedAttempts / rate;
  console.log('   Estimated time for "PARTY":', (estimatedSeconds / 60).toFixed(1), 'minutes');
}

console.log('\n=== TEST COMPLETE ===');