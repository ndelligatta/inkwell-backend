// Test script for platform fee claiming
const axios = require('axios');

async function testClaimFees(poolAddress) {
  try {
    console.log('Testing fee claiming endpoint...');
    console.log('Pool address:', poolAddress);
    
    // First check the fees available
    console.log('\n1. Checking available fees...');
    const feeResponse = await axios.get(`http://localhost:3001/api/pool-fees/${poolAddress}`);
    console.log('Fee metrics:', feeResponse.data);
    
    if (!feeResponse.data.hasFeesToClaim) {
      console.log('No fees to claim for this pool');
      return;
    }
    
    console.log(`\n2. Claiming ${feeResponse.data.availableFeesSOL} SOL...`);
    
    // Claim the fees
    const claimResponse = await axios.post('http://localhost:3001/api/claim-platform-fees', {
      poolAddress
    }, {
      headers: {
        'Authorization': 'Bearer admin-secret',
        'Content-Type': 'application/json'
      }
    });
    
    console.log('\nClaim response:', claimResponse.data);
    
    if (claimResponse.data.success) {
      console.log('\n✅ Fees claimed successfully!');
      console.log('Transaction:', claimResponse.data.signature);
      console.log('Amount claimed:', claimResponse.data.claimedAmount, 'SOL');
      console.log('View on Solscan:', claimResponse.data.solscanUrl);
    } else {
      console.error('❌ Fee claiming failed:', claimResponse.data.error);
    }
    
  } catch (error) {
    console.error('Error calling API:', error.response?.data || error.message);
  }
}

// Get pool address from command line argument or use a default
const poolAddress = process.argv[2];

if (!poolAddress) {
  console.error('Usage: node test-claim-fees.js <POOL_ADDRESS>');
  console.error('Example: node test-claim-fees.js B4mRHzKE71azZx7kjbkdVaCVDehAL93jeiZ1xzBGmm3B');
  process.exit(1);
}

testClaimFees(poolAddress);