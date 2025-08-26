// FIND PARTY - NO FUCKING TIMEOUTS!
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default;

console.log('\n🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉');
console.log('🎉 FINDING ADDRESSES ENDING WITH "PARTY" 🎉');
console.log('🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉');
console.log('✨ TARGET: "PARTY" (5 characters)');
console.log('📊 Probability: 1 in 656,356,768');
console.log('🚀 NO TIMEOUTS - WILL RUN UNTIL FOUND!');
console.log('🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉\n');

async function findPARTY() {
  const startTime = Date.now();
  const checkSuffix = 'party';
  let attempts = 0;
  
  console.log('🔍 SEARCHING FOR "PARTY"... NO FUCKING TIMEOUTS!\n');
  
  // NO TIMEOUT - KEEP GOING UNTIL WE FIND IT!
  while (true) {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    attempts++;
    
    // Case-insensitive check
    if (address.toLowerCase().endsWith(checkSuffix)) {
      const elapsed = (Date.now() - startTime) / 1000;
      const exactMatch = address.endsWith('PARTY');
      
      console.log('\n🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉');
      console.log('🎉 HOLY SHIT! FOUND A PARTY ADDRESS! 🎉');
      console.log('🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉\n');
      console.log(`🔥 ADDRESS: ${address}`);
      console.log(`🔥 LAST 5 CHARS: "${address.slice(-5)}"`);
      console.log(`🔥 EXACT MATCH "PARTY": ${exactMatch ? 'YES! 🎯' : 'No (case mismatch)'}`);
      console.log(`🔥 ATTEMPTS: ${attempts.toLocaleString()}`);
      console.log(`🔥 TIME: ${elapsed.toFixed(2)} seconds (${(elapsed/60).toFixed(2)} minutes)`);
      console.log(`🔥 RATE: ${Math.floor(attempts/elapsed).toLocaleString()} addresses/second`);
      
      console.log('\n✅ PROOF THAT WE CAN GENERATE PARTY ADDRESSES!');
      console.log(`✅ Secret key (base58): ${bs58.encode(keypair.secretKey)}`);
      console.log('✅ This address can be used for token launches!');
      
      return {
        public_key: address,
        secret_key: bs58.encode(keypair.secretKey),
        has_vanity_suffix: true,
        vanity_suffix: 'PARTY'
      };
    }
    
    // Progress update every 500k attempts
    if (attempts % 500000 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = attempts / elapsed;
      const percentDone = (attempts / 656356768) * 100;
      
      console.log(`⏳ STILL SEARCHING... ${attempts.toLocaleString()} attempts`);
      console.log(`   Time: ${(elapsed/60).toFixed(1)} minutes | Rate: ${rate.toFixed(0)} addr/sec | Progress: ${percentDone.toFixed(3)}%`);
    }
    
    // Yield to event loop
    if (attempts % 1000 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

// RUN IT!
console.log('💪 Starting the search... This WILL find a PARTY address!\n');
findPARTY().catch(console.error);