// Test bs58 usage
const bs58 = require('bs58');

console.log('bs58 object:', bs58);
console.log('typeof bs58:', typeof bs58);
console.log('bs58.encode:', bs58.encode);
console.log('bs58.decode:', bs58.decode);

// Test with a sample buffer
const testBuffer = Buffer.from([1, 2, 3, 4, 5]);
console.log('\nTest buffer:', testBuffer);

try {
  // Try direct call
  const encoded = bs58.encode(testBuffer);
  console.log('Direct encode worked:', encoded);
} catch (e) {
  console.log('Direct encode failed:', e.message);
  
  try {
    // Try as default export
    const encoded = bs58.default.encode(testBuffer);
    console.log('Default encode worked:', encoded);
  } catch (e2) {
    console.log('Default encode also failed:', e2.message);
  }
}