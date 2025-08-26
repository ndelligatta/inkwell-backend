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
  console.log('=== VANITY KEYPAIR GENERATION START ===');
  console.log(`Target suffix: "${suffix}"`);
  console.log(`Case sensitive: ${caseSensitive}`);
  console.log(`Worker threads: ${threads}`);
  console.log(`Timeout: ${timeout} seconds`);
  console.log(`Available CPUs: ${os.cpus().length}`);
  console.log(`System info: ${os.type()} ${os.platform()} ${os.arch()}`);
  console.log(`Node version: ${process.version}`);
  
  return new Promise((resolve, reject) => {
    const workers = [];
    let found = false;
    const startTime = Date.now();
    let totalAttempts = 0;
    const workerAttempts = new Map(); // Track attempts per worker
    
    console.log(`\nStarting ${threads} worker threads to search for address ending with "${suffix}"...`);
    
    // Set timeout
    const timeoutId = setTimeout(() => {
      if (!found) {
        found = true;
        console.log('\n=== TIMEOUT REACHED ===');
        console.log(`Total attempts before timeout: ${totalAttempts.toLocaleString()}`);
        console.log('Worker attempts breakdown:');
        workerAttempts.forEach((attempts, workerId) => {
          console.log(`  Worker ${workerId}: ${attempts.toLocaleString()} attempts`);
        });
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
          console.log(`\n=== VANITY ADDRESS FOUND ===`);
          console.log(`Worker found match!`);
          
          // Terminate all workers
          workers.forEach(w => w.terminate());
          
          // Create keypair from secret key
          const keypair = Keypair.fromSecretKey(new Uint8Array(data.secretKey));
          
          const elapsed = (Date.now() - startTime) / 1000;
          console.log(`\n=== VANITY GENERATION SUCCESS ===`);
          console.log(`Address: ${data.address}`);
          console.log(`Ends with "${suffix}": ${data.address.endsWith(suffix)}`);
          console.log(`Total attempts: ${(totalAttempts + data.attempts).toLocaleString()}`);
          console.log(`Time: ${elapsed.toFixed(2)}s`);
          console.log(`Rate: ${Math.floor((totalAttempts + data.attempts) / elapsed).toLocaleString()} addresses/second`);
          console.log(`Workers used: ${threads}`);
          console.log(`=====================================\n`);
          
          resolve(keypair);
        } else if (!data.found) {
          // Progress update
          totalAttempts += data.attempts;
          workerAttempts.set(workers.indexOf(worker), (workerAttempts.get(workers.indexOf(worker)) || 0) + data.attempts);
          
          if (totalAttempts % 500000 === 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = totalAttempts / elapsed;
            const eta = ((58 ** suffix.length) / rate) / 60; // Rough ETA in minutes
            console.log(`\n=== PROGRESS UPDATE ===`);
            console.log(`Total attempts: ${totalAttempts.toLocaleString()}`);
            console.log(`Rate: ${rate.toFixed(0)} addresses/second`);
            console.log(`Elapsed: ${elapsed.toFixed(1)}s`);
            console.log(`Estimated time for "${suffix}": ${eta.toFixed(1)} minutes`);
            console.log(`======================`);
          }
        }
      });
      
      worker.on('error', (error) => {
        console.error(`\n=== WORKER ERROR ===`);
        console.error(`Worker ${workers.length} error:`, error);
        console.error(`Stack:`, error.stack);
        console.error(`===================`);
      });
      
      worker.on('exit', (code) => {
        if (code !== 0 && !found) {
          console.error(`Worker exited with code ${code}`);
        }
      });
      
      workers.push(worker);
    }
    
    console.log(`\nAll ${threads} workers started successfully!`);
  });
}

module.exports = {
  generateVanityKeypair,
  generateVanityKeypairMultiThreaded
};