// Test the updated migration check
const { checkPoolMigration } = require('./checkPoolMigration');

async function test() {
  const poolAddress = "DMMkjnyCg89tYPYNZAcFXdt9djWCCbyQwWvvXg1cZuQR";
  console.log('Testing migration check for pool:', poolAddress);
  console.log('');
  
  const result = await checkPoolMigration(poolAddress);
  console.log('\nResult:', JSON.stringify(result, null, 2));
}

test();