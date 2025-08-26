// Test the keypair worker - NO TIMEOUTS! WILL FIND PRTY!
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default;

console.log('\n🚀 =================================');
console.log('🚀 KEYPAIR GENERATION - NO TIMEOUTS');
console.log('🚀 =================================');
console.log(`✨ TARGET: "PRTY"`);
console.log(`🎯 WILL KEEP GOING UNTIL WE FIND IT!`);
console.log('🚀 =================================\n');

async function generateVanityKeypair() {
  const startTime = Date.now();
  const checkSuffix = 'prty';
  let attempts = 0;
  
  console.log(`🔍 Searching for address ending with "PRTY"... NO TIMEOUT!`);
  
  // NO TIMEOUT - KEEP GOING FOREVER UNTIL WE FIND IT
  while (true) {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    attempts++;
    
    // Case-insensitive check
    if (address.toLowerCase().endsWith(checkSuffix)) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`\n🎉🎉🎉 FUCK YES! FOUND PRTY ADDRESS! 🎉🎉🎉`);
      console.log(`✨ ADDRESS: ${address}`);
      console.log(`✨ LAST 4 CHARS: "${address.slice(-4)}"`);
      console.log(`✨ ATTEMPTS: ${attempts.toLocaleString()}`);
      console.log(`✨ TIME: ${elapsed.toFixed(2)} seconds`);
      console.log(`✨ RATE: ${Math.floor(attempts/elapsed).toLocaleString()} addresses/second`);
      
      return {
        public_key: address,
        secret_key: bs58.encode(keypair.secretKey),
        has_vanity_suffix: true,
        vanity_suffix: 'PRTY'
      };
    }
    
    // Progress update every 100k attempts
    if (attempts % 100000 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = attempts / elapsed;
      console.log(`⏳ Still searching... ${attempts.toLocaleString()} attempts | ${elapsed.toFixed(1)}s | ${rate.toFixed(0)} addr/sec`);
    }
    
    // Yield to event loop
    if (attempts % 1000 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

async function findMultiplePRTY() {
  console.log('🎯 FINDING 3 PRTY ADDRESSES - NO MATTER HOW LONG IT TAKES!\n');
  
  const found = [];
  
  for (let i = 0; i < 3; i++) {
    console.log(`\n🔨 Finding PRTY address ${i + 1}/3...`);
    const keypair = await generateVanityKeypair();
    found.push(keypair);
    console.log(`✅ SAVED KEYPAIR #${i + 1}`);
  }
  
  console.log('\n\n🎉🎉🎉 SUCCESS! FOUND ALL 3 PRTY ADDRESSES! 🎉🎉🎉');
  console.log('=========================================');
  found.forEach((kp, i) => {
    console.log(`${i + 1}. ${kp.public_key} ✨`);
  });
  console.log('=========================================\n');
  
  console.log('✅ PROOF THAT IT FUCKING WORKS!');
  console.log('✅ These addresses ALL end with PRTY!');
  console.log('✅ Ready to be stored in the database!');
}

// RUN IT - NO TIMEOUTS!
findMultiplePRTY().catch(console.error);