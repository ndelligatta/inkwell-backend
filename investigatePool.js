// Investigate pool type
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const POOL_ADDRESS = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";
const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

async function investigate() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const poolPubkey = new PublicKey(POOL_ADDRESS);
  
  try {
    console.log('Investigating pool:', POOL_ADDRESS);
    
    // Get account info
    const accountInfo = await connection.getAccountInfo(poolPubkey);
    
    if (!accountInfo) {
      console.log('Pool account not found!');
      return;
    }
    
    console.log('\nAccount Info:');
    console.log('Owner Program:', accountInfo.owner.toString());
    console.log('Data length:', accountInfo.data.length);
    console.log('Lamports:', accountInfo.lamports);
    console.log('Executable:', accountInfo.executable);
    
    // Known program IDs
    const PROGRAMS = {
      'CPAMxqbB9eJCdksutGg49Q7iu1EnfhXF2F1YQ5gMuQiW': 'Meteora CP-AMM (DAMM v2)',
      'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Meteora Dynamic AMM',
      'BAMFvzPNQXzsVVxFaDwaNJpiJtVBqmXQh4Ufkb3mBfLP': 'Meteora BAMM',
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM V4',
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium Concentrated AMM',
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
      'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
      '7DAbJB8gWTFJV5VGTKCb6rqUg1dKBmPrxXpBsqUnXJ4P': 'Meteora Alpha Vault',
      'MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky': 'Meteora Pools'
    };
    
    const programName = PROGRAMS[accountInfo.owner.toString()] || 'Unknown Program';
    console.log('Program Name:', programName);
    
    // Check if it's a token account
    if (accountInfo.owner.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
        accountInfo.owner.toString() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
      console.log('This is a Token Account, not a liquidity pool');
      
      // Parse token account
      const { getAccount } = require('@solana/spl-token');
      const tokenAccount = await getAccount(connection, poolPubkey);
      console.log('\nToken Account Info:');
      console.log('Mint:', tokenAccount.mint.toString());
      console.log('Owner:', tokenAccount.owner.toString());
      console.log('Amount:', tokenAccount.amount.toString());
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

investigate();