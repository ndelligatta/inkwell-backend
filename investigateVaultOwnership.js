// Investigate the vault ownership and fee structure
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { CpAmm } = require('@meteora-ag/cp-amm-sdk');
const bs58 = require('bs58').default;
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount } = require('@solana/spl-token');

const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Known addresses
const DAMM_V2_POOL = "5LU223t4zWhmC9duVkRdnnFJhvtHSHHsfCfNFz98i1Jg";
const SYSTEM_ACCOUNT = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"; // Owner of the vault
const TOKEN_B_VAULT = "6BhavFgfjt6maz1inPus9HCpRTGhYWRQpXqHigKeXm5a"; // Has 11.88 SOL

async function investigate() {
  try {
    console.log('====== VAULT OWNERSHIP INVESTIGATION ======\n');
    
    const connection = new Connection(RPC_URL, 'confirmed');
    const adminKeypair = Keypair.fromSecretKey(bs58.decode(ADMIN_PRIVATE_KEY));
    
    // 1. Check who can withdraw from the vault
    console.log('=== Vault Analysis ===');
    const vaultPubkey = new PublicKey(TOKEN_B_VAULT);
    const vaultAccount = await getAccount(connection, vaultPubkey);
    
    console.log('Vault address:', TOKEN_B_VAULT);
    console.log('Vault owner (who can withdraw):', vaultAccount.owner.toString());
    console.log('Vault amount:', (Number(vaultAccount.amount) / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Vault mint:', vaultAccount.mint.toString());
    
    // 2. Check what the system account is
    console.log('\n=== System Account Analysis ===');
    const systemAccountPubkey = new PublicKey(SYSTEM_ACCOUNT);
    const systemAccount = await connection.getAccountInfo(systemAccountPubkey);
    
    console.log('System account:', SYSTEM_ACCOUNT);
    console.log('Lamports:', (systemAccount.lamports / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Owner:', systemAccount.owner.toString());
    console.log('Data length:', systemAccount.data.length);
    
    // Check if it's a PDA
    console.log('\nChecking if system account is a PDA...');
    
    // Try common PDA seeds for Meteora
    const seeds = [
      ['pool', new PublicKey(DAMM_V2_POOL).toBuffer()],
      ['vault', new PublicKey(DAMM_V2_POOL).toBuffer()],
      ['fee_vault', new PublicKey(DAMM_V2_POOL).toBuffer()],
      ['protocol_fee', new PublicKey(DAMM_V2_POOL).toBuffer()],
      ['partner_fee', new PublicKey(DAMM_V2_POOL).toBuffer()]
    ];
    
    for (const seed of seeds) {
      try {
        const [pda] = PublicKey.findProgramAddressSync(
          seed,
          new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')
        );
        if (pda.equals(systemAccountPubkey)) {
          console.log(`✅ System account is a PDA with seed: ${seed[0]}`);
        }
      } catch (e) {
        // Ignore
      }
    }
    
    // 3. Check the DAMM pool's fee configuration
    console.log('\n=== DAMM Pool Fee Configuration ===');
    const cpAmm = new CpAmm(connection);
    const dammPoolPubkey = new PublicKey(DAMM_V2_POOL);
    const poolState = await cpAmm.fetchPoolState(dammPoolPubkey);
    
    console.log('Pool protocolFeeRate:', poolState.protocolFeeRate);
    console.log('Pool fundFeeRate:', poolState.fundFeeRate);
    
    // Try to find fee-related accounts
    console.log('\n=== Searching for fee accounts ===');
    
    // Common Meteora fee account PDAs
    const feeSeeds = [
      ['fee_owner'],
      ['protocol_fee_owner'],
      ['fund_fee_owner'],
      ['partner_fee_owner']
    ];
    
    for (const seed of feeSeeds) {
      try {
        const [feePda] = PublicKey.findProgramAddressSync(
          [Buffer.from(seed[0])],
          new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')
        );
        console.log(`${seed[0]} PDA:`, feePda.toString());
        
        // Check if this PDA owns any token accounts
        const tokenAccounts = await connection.getTokenAccountsByOwner(feePda, {
          mint: new PublicKey('So11111111111111111111111111111111111111112')
        });
        
        if (tokenAccounts.value.length > 0) {
          console.log(`  Found ${tokenAccounts.value.length} SOL token accounts!`);
          for (const account of tokenAccounts.value) {
            const tokenAccount = await getAccount(connection, account.pubkey);
            const balance = Number(tokenAccount.amount) / LAMPORTS_PER_SOL;
            console.log(`  - ${account.pubkey.toString()}: ${balance.toFixed(6)} SOL`);
          }
        }
      } catch (e) {
        // Ignore
      }
    }
    
    // 4. Check if admin can claim as partner
    console.log('\n=== Checking admin as partner ===');
    console.log('Admin wallet:', adminKeypair.publicKey.toString());
    
    // Check if admin owns the system account
    if (systemAccount.owner.equals(PublicKey.default)) {
      // System owned account - check if admin has authority
      console.log('System account is owned by System Program');
      
      // Try to transfer lamports from system account
      console.log('\nChecking if admin can withdraw SOL from system account...');
      // This would require the account to be a PDA that admin controls
    }
    
    // 5. Try CP-AMM partner fee claim
    console.log('\n=== Attempting CP-AMM partner fee claim ===');
    try {
      // Check if there's a claimPartnerFee method
      const poolInfo = await cpAmm.fetchPoolInfo(dammPoolPubkey);
      console.log('Pool info keys:', Object.keys(poolInfo));
      
      // Try to find partner-specific claim methods in the SDK
      console.log('\nChecking available claim methods...');
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(cpAmm))
        .filter(name => name.includes('claim') || name.includes('partner') || name.includes('fee'));
      console.log('Available methods:', methods);
      
    } catch (error) {
      console.error('Error checking partner fees:', error.message);
    }
    
    // 6. Final analysis
    console.log('\n=== ANALYSIS ===');
    console.log('1. The vault with 11.88 SOL is owned by:', vaultAccount.owner.toString());
    console.log('2. This owner is a System Program account, not the DAMM pool');
    console.log('3. To withdraw these fees, you need to be able to sign for the owner account');
    console.log('4. The owner account might be a PDA or a special fee collection account');
    console.log('\nPossible solutions:');
    console.log('- The system account might be a fee collection PDA that requires special instructions');
    console.log('- There might be a specific "claim protocol fees" or "claim partner fees" instruction');
    console.log('- The fees might need to be claimed through a different mechanism than position claims');

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error('Stack:', error.stack);
  }
}

investigate();