// Test the keypair worker locally
require('dotenv').config();

// Check if we have the required environment variables
console.log('=== ENVIRONMENT CHECK ===');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ Set' : '❌ Missing');
console.log('SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Set' : '❌ Missing');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('\n❌ Missing required environment variables!');
  console.log('\nTo run this test, you need to set:');
  console.log('- SUPABASE_URL');
  console.log('- SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Set test configuration
process.env.KEYPAIR_POOL_SIZE = '10'; // Small pool for testing
process.env.KEYPAIR_BATCH_SIZE = '3'; // Small batch for testing
process.env.CHECK_INTERVAL_MS = '10000'; // 10 seconds

console.log('\n=== STARTING KEYPAIR WORKER TEST ===');
console.log('This will generate a small batch of keypairs...\n');

// Run the worker
require('./keypairWorker');