// Vanity Keypair Generator for Solana addresses ending with "PARTY"
const { Keypair } = require('@solana/web3.js');
const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');

/**
 * Generate a vanity keypair with specific suffix
 * @param {string} suffix - The suffix to search for (e.g., "PARTY")
 * @param {boolean} caseSensitive - Whether to match case exactly
 * @param {number} maxAttempts - Maximum attempts before giving up (default: 5 million)
 * @returns {Promise<Keypair>} - The generated keypair
 */
async function generateVanityKeypair(suffix, caseSensitive = false, maxAttempts = 5000000) {
  const checkSuffix = caseSensitive ? suffix : suffix.toLowerCase();
  
  let keypair;
  let address;
  let attempts = 0;
  const startTime = Date.now();
  
  console.log(`Searching for address ending with "${suffix}"...`);
  
  do {
    keypair = Keypair.generate();
    address = keypair.publicKey.toBase58();
    attempts++;
    
    // Convert address for comparison if not case sensitive
    const checkAddress = caseSensitive ? address : address.toLowerCase();
    
    // Check if address ends with desired suffix
    if (checkAddress.endsWith(checkSuffix)) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`Found vanity address!`);
      console.log(`Address: ${address}`);
      console.log(`Attempts: ${attempts.toLocaleString()}`);
      console.log(`Time: ${elapsed.toFixed(2)}s`);
      console.log(`Rate: ${Math.floor(attempts / elapsed).toLocaleString()} addresses/second`);
      return keypair;
    }
    
    // Log progress every 100,000 attempts
    if (attempts % 100000 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = attempts / elapsed;
      console.log(`Progress: ${attempts.toLocaleString()} attempts, ${rate.toFixed(0)} addr/sec`);
    }
    
    // Check if we've exceeded max attempts
    if (attempts >= maxAttempts) {
      throw new Error(`Failed to find address ending with "${suffix}" after ${maxAttempts.toLocaleString()} attempts`);
    }
    
  } while (true);
}

/**
 * Multi-threaded vanity keypair generator for better performance
 * @param {string} suffix - The suffix to search for
 * @param {boolean} caseSensitive - Whether to match case exactly
 * @param {number} threads - Number of worker threads to use
 * @param {number} timeout - Timeout in seconds (default: 300 seconds / 5 minutes)
 * @returns {Promise<Keypair>} - The generated keypair
 */
async function generateVanityKeypairMultiThreaded(suffix, caseSensitive = false, threads = Math.floor(os.cpus().length / 2), timeout = 300) {
  return new Promise((resolve, reject) => {
    const workers = [];
    let found = false;
    const startTime = Date.now();
    let totalAttempts = 0;
    
    console.log(`Starting ${threads} worker threads to search for address ending with "${suffix}"...`);
    
    // Set timeout
    const timeoutId = setTimeout(() => {
      if (!found) {
        found = true;
        workers.forEach(w => w.terminate());
        reject(new Error(`Timeout: Failed to find address ending with "${suffix}" after ${timeout} seconds`));
      }
    }, timeout * 1000);
    
    // Create worker threads
    for (let i = 0; i < threads; i++) {
      const worker = new Worker(path.join(__dirname, 'vanityWorker.js'), {
        workerData: { suffix, caseSensitive }
      });
      
      worker.on('message', (data) => {
        if (data.found && !found) {
          found = true;
          clearTimeout(timeoutId);
          
          // Terminate all workers
          workers.forEach(w => w.terminate());
          
          // Create keypair from secret key
          const keypair = Keypair.fromSecretKey(new Uint8Array(data.secretKey));
          
          const elapsed = (Date.now() - startTime) / 1000;
          console.log(`\nFound vanity address!`);
          console.log(`Address: ${data.address}`);
          console.log(`Total attempts: ${(totalAttempts + data.attempts).toLocaleString()}`);
          console.log(`Time: ${elapsed.toFixed(2)}s`);
          console.log(`Rate: ${Math.floor((totalAttempts + data.attempts) / elapsed).toLocaleString()} addresses/second`);
          
          resolve(keypair);
        } else if (!data.found) {
          // Progress update
          totalAttempts += data.attempts;
          if (totalAttempts % 1000000 === 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = totalAttempts / elapsed;
            console.log(`Progress: ${totalAttempts.toLocaleString()} total attempts, ${rate.toFixed(0)} addr/sec`);
          }
        }
      });
      
      worker.on('error', (error) => {
        console.error(`Worker error:`, error);
      });
      
      workers.push(worker);
    }
  });
}

module.exports = {
  generateVanityKeypair,
  generateVanityKeypairMultiThreaded
};