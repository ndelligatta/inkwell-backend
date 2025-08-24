// Test script for config creation
const axios = require('axios');

async function testCreateConfig() {
  try {
    console.log('Testing config creation endpoint...');
    
    const response = await axios.post('http://localhost:3001/api/create-config', {}, {
      headers: {
        'Authorization': 'Bearer admin-secret',
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Response:', response.data);
    
    if (response.data.success) {
      console.log('\n✅ Config created successfully!');
      console.log('Config address:', response.data.configAddress);
      console.log('Transaction:', response.data.signature);
      console.log('\nIMPORTANT: Update your .env file:');
      console.log(`DBC_CONFIG_PUBKEY=${response.data.configAddress}`);
    } else {
      console.error('❌ Config creation failed:', response.data.error);
    }
    
  } catch (error) {
    console.error('Error calling API:', error.response?.data || error.message);
  }
}

// Run the test
testCreateConfig();