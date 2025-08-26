// Test vanity keypair generation
const { generateVanityKeypair, generateVanityKeypairMultiThreaded } = require('./vanityKeypairGenerator');

async function test() {
  console.log('=== Testing Vanity Keypair Generator ===\n');
  
  // Test 1: Single-threaded generation with a short suffix
  console.log('Test 1: Single-threaded generation for address ending with "XY"');
  try {
    const keypair1 = await generateVanityKeypair('XY', false, 1000000);
    console.log('Success!\n');
  } catch (error) {
    console.error('Failed:', error.message, '\n');
  }
  
  // Test 2: Multi-threaded generation with "PARTY"
  console.log('Test 2: Multi-threaded generation for address ending with "PARTY"');
  try {
    const keypair2 = await generateVanityKeypairMultiThreaded('PARTY', true, 4, 120);
    console.log('Success!\n');
    
    // Verify the address
    const address = keypair2.publicKey.toBase58();
    console.log('Verification: Address ends with PARTY?', address.endsWith('PARTY'));
  } catch (error) {
    console.error('Failed:', error.message, '\n');
  }
  
  // Test 3: Case-insensitive search (should be faster)
  console.log('Test 3: Case-insensitive search for "party"');
  try {
    const keypair3 = await generateVanityKeypairMultiThreaded('party', false, 4, 60);
    console.log('Success!\n');
  } catch (error) {
    console.error('Failed:', error.message, '\n');
  }
}

test().catch(console.error);