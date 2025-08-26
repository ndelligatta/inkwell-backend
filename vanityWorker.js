// Worker thread for vanity keypair generation
const { parentPort, workerData } = require('worker_threads');
const { Keypair } = require('@solana/web3.js');

const { suffix, caseSensitive } = workerData;

function search() {
  const checkSuffix = caseSensitive ? suffix : suffix.toLowerCase();
  
  let attempts = 0;
  
  while (true) {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    attempts++;
    
    const checkAddress = caseSensitive ? address : address.toLowerCase();
    
    if (checkAddress.endsWith(checkSuffix)) {
      // Found a match!
      parentPort.postMessage({
        found: true,
        address: address,
        secretKey: Array.from(keypair.secretKey),
        attempts: attempts
      });
      break;
    }
    
    // Report progress every 50,000 attempts
    if (attempts % 50000 === 0) {
      parentPort.postMessage({
        found: false,
        attempts: 50000
      });
      attempts = 0; // Reset counter to avoid overflow
    }
  }
}

// Start searching
search();