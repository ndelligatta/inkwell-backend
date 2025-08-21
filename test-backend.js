// Test script for backend token launcher
require('dotenv').config();

async function testBackend() {
  const baseUrl = 'http://localhost:3001';
  
  console.log('Testing backend token launcher...\n');
  
  // 1. Test health check
  try {
    const healthResponse = await fetch(`${baseUrl}/health`);
    const healthData = await healthResponse.json();
    console.log('✅ Health check:', healthData);
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    console.log('Make sure the backend is running: npm start');
    return;
  }
  
  // 2. Test token launch with mock data
  const testMetadata = {
    name: 'Test Token',
    symbol: 'TEST',
    description: 'This is a test token',
    website: 'https://example.com',
    twitter: 'https://twitter.com/test',
    initialBuyAmount: 0.01,
    userId: 'test-user-id',
    // You would need a real dev wallet private key here
    userPrivateKey: process.env.TEST_PRIVATE_KEY || null
  };
  
  if (!testMetadata.userPrivateKey) {
    console.log('\n⚠️  No TEST_PRIVATE_KEY in .env file');
    console.log('To fully test token launch, add a test wallet private key to .env');
    console.log('You can get one from a dev wallet in the database\n');
    
    // Test validation only
    console.log('Testing validation endpoint...');
    try {
      const response = await fetch(`${baseUrl}/api/launch-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '',
          symbol: '',
          userId: ''
        })
      });
      
      const result = await response.json();
      console.log('Validation test response:', result);
      
      if (!result.success && result.error.includes('required')) {
        console.log('✅ Validation working correctly');
      }
    } catch (error) {
      console.error('❌ Validation test failed:', error.message);
    }
    
    return;
  }
  
  // 3. Test full token launch
  console.log('\nTesting full token launch...');
  console.log('Metadata:', testMetadata);
  
  try {
    const response = await fetch(`${baseUrl}/api/launch-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testMetadata)
    });
    
    const result = await response.json();
    
    if (result.success) {
      console.log('\n✅ Token launch successful!');
      console.log('Mint address:', result.mintAddress);
      console.log('Pool address:', result.poolAddress);
      console.log('Transaction:', result.transactionSignature);
      console.log('Solscan:', result.solscanUrl);
    } else {
      console.log('\n❌ Token launch failed:');
      console.log('Error:', result.error);
      if (result.details) {
        console.log('Details:', result.details);
      }
    }
  } catch (error) {
    console.error('\n❌ Request failed:', error.message);
  }
}

// Run test
testBackend().then(() => {
  console.log('\nTest complete');
  process.exit(0);
}).catch(error => {
  console.error('Test error:', error);
  process.exit(1);
});