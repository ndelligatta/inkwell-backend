// Test script to launch Daily Bugle token
const axios = require('axios');

// Configuration
const API_ENDPOINT = 'https://inkwell-backend-production.up.railway.app/api/daily-bugle-launch';
const AUTH_TOKEN = 'bugle-secret-2024'; // Default token, can be overridden with env var

async function launchDailyBugle() {
  console.log('🗞️ Daily Bugle Token Launch Test');
  console.log('================================');
  console.log('Endpoint:', API_ENDPOINT);
  console.log('Auth Token:', AUTH_TOKEN);
  console.log('');
  
  try {
    console.log('📡 Sending launch request...');
    
    const response = await axios.post(
      API_ENDPOINT,
      {}, // Empty body - all values are hardcoded
      {
        headers: {
          'Authorization': `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Success! Daily Bugle token launched');
    console.log('');
    console.log('📊 Launch Results:');
    console.log('Mint Address:', response.data.mintAddress);
    console.log('Pool Address:', response.data.poolAddress);
    console.log('Transaction:', response.data.transactionSignature);
    console.log('Explorer:', response.data.explorerUrl);
    console.log('Post ID:', response.data.postId);
    console.log('');
    console.log('🎉 Token successfully launched and posted on BlockParty!');
    
  } catch (error) {
    console.error('❌ Launch failed!');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Error:', error.response.data);
    } else {
      console.error('Error:', error.message);
    }
  }
}

// Run the test
launchDailyBugle();