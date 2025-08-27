// Test available methods in CP AMM SDK
const { CpAmm } = require('@meteora-ag/cp-amm-sdk');
const { Connection } = require('@solana/web3.js');

const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, 'confirmed');
const cpAmm = new CpAmm(connection);

console.log('Available methods in CpAmm:');
console.log('=========================');

// List all methods
const proto = Object.getPrototypeOf(cpAmm);
const methods = Object.getOwnPropertyNames(proto)
  .filter(name => typeof cpAmm[name] === 'function' && name !== 'constructor')
  .sort();

methods.forEach(method => {
  console.log(`- ${method}`);
});

// Check specifically for claim methods
console.log('\nClaim-related methods:');
methods.filter(m => m.toLowerCase().includes('claim')).forEach(method => {
  console.log(`- ${method}`);
});

// Check for position methods
console.log('\nPosition-related methods:');
methods.filter(m => m.toLowerCase().includes('position')).forEach(method => {
  console.log(`- ${method}`);
});