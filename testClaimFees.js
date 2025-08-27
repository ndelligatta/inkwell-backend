// Test script for fee claiming with retry logic
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');

const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const POOL_ADDRESS = "BeYmB9Lii4xBkgqpNyBqLb3yu9CbLrX7AHSqPXWZifck";

async function testConnection() {
  console.log('Testing connection to Helius RPC...');
  
  // Try multiple RPC endpoints
  const endpoints = [
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
    `https://api.mainnet-beta.solana.com`,
    `https://solana-mainnet.g.alchemy.com/v2/demo`
  ];
  
  for (const endpoint of endpoints) {
    console.log(`\nTrying endpoint: ${endpoint.substring(0, 50)}...`);
    
    try {
      const connection = new Connection(endpoint, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 30000,
        httpHeaders: {
          'Content-Type': 'application/json',
        }
      });
      
      // Test basic connection
      const slot = await connection.getSlot();
      console.log(`✓ Connected! Current slot: ${slot}`);
      
      // Test DBC client
      console.log('\nTesting DBC client with pool:', POOL_ADDRESS);
      const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');
      const poolPubkey = new PublicKey(POOL_ADDRESS);
      
      console.log('Fetching pool account info...');
      const poolAccount = await connection.getAccountInfo(poolPubkey);
      if (!poolAccount) {
        console.log('❌ Pool account not found');
        continue;
      }
      console.log(`✓ Pool account found, owner: ${poolAccount.owner.toString()}`);
      
      console.log('\nFetching fee metrics...');
      const feeMetrics = await dbcClient.state.getPoolFeeMetrics(poolPubkey);
      
      if (feeMetrics && feeMetrics.current) {
        console.log('✓ Fee metrics retrieved successfully!');
        console.log('Partner Quote Fee:', feeMetrics.current.partnerQuoteFee.toNumber() / LAMPORTS_PER_SOL, 'SOL');
        console.log('Partner Base Fee:', feeMetrics.current.partnerBaseFee.toString());
        console.log('Creator Quote Fee:', feeMetrics.current.creatorQuoteFee.toNumber() / LAMPORTS_PER_SOL, 'SOL');
        console.log('Creator Base Fee:', feeMetrics.current.creatorBaseFee.toString());
        
        return { success: true, endpoint, feeMetrics };
      } else {
        console.log('❌ No fee metrics returned');
      }
      
    } catch (error) {
      console.log(`❌ Error with ${endpoint.substring(0, 30)}...:`, error.message);
      if (error.cause) {
        console.log('Cause:', error.cause.message || error.cause);
      }
    }
  }
  
  return { success: false, error: 'All endpoints failed' };
}

// Run the test
testConnection()
  .then(result => {
    console.log('\n=== TEST COMPLETE ===');
    if (result.success) {
      console.log('✓ Successfully connected and retrieved fee data');
      console.log('Working endpoint:', result.endpoint.substring(0, 50) + '...');
    } else {
      console.log('❌ All connection attempts failed');
    }
    process.exit(result.success ? 0 : 1);
  })
  .catch(error => {
    console.error('\nUnexpected error:', error);
    process.exit(1);
  });