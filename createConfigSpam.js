// Special config creation with reduced migration threshold and hard-coded key
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const BN = require('bn.js');
const bs58 = require('bs58').default;

// Prefer IPv4 resolution to avoid IPv6 egress issues
try {
  const dns = require('node:dns');
  if (dns && typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (_) {}

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null;
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const NATIVE_SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Admin private key provided via environment (Railway): spam_unlock (preferred) or SPAM_UNLOCK
const SPAM_UNLOCK = (process.env.spam_unlock || process.env.SPAM_UNLOCK || '').trim();

async function createInkwellConfigSpam() {
  try {
    console.log('====== CREATING INKWELL CONFIG (SPAM VARIANT) ======');
    // Build connection with fallback if Helius is unavailable
    let connection = new Connection(HELIUS_RPC || PUBLIC_RPC, 'confirmed');
    try {
      await connection.getLatestBlockhash('confirmed');
    } catch (e) {
      console.warn('Primary RPC failed, falling back to public RPC:', e?.message || e);
      connection = new Connection(PUBLIC_RPC, 'confirmed');
      // Probe fallback too
      await connection.getLatestBlockhash('confirmed');
    }
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');

    // Use admin keypair from environment variable
    if (!SPAM_UNLOCK) {
      throw new Error('Missing spam_unlock (SPAM_UNLOCK) environment variable');
    }
    const adminKeypair = Keypair.fromSecretKey(bs58.decode(SPAM_UNLOCK));
    console.log('Admin wallet (spam):', adminKeypair.publicKey.toString());

    const balance = await connection.getBalance(adminKeypair.publicKey);
    console.log('Admin balance:', balance / LAMPORTS_PER_SOL, 'SOL');
    if (balance < 0.05 * LAMPORTS_PER_SOL) {
      throw new Error('Insufficient balance. Need ~0.05 SOL for fees');
    }

    const configKeypair = Keypair.generate();
    console.log('New config address will be:', configKeypair.publicKey.toString());

    const bagsCurve = [
      { sqrtPrice: new BN("6401204812200420"), liquidity: new BN("3929368168768468756200000000000000") },
      { sqrtPrice: new BN("13043817825332782"), liquidity: new BN("2425988008058820449100000000000000") }
    ];

    // Reduced migration threshold to 0.01 SOL
    const configParams = {
      poolFees: {
        baseFee: {
          cliffFeeNumerator: new BN(40_000_000),
          firstFactor: 0,
          secondFactor: new BN(0),
          thirdFactor: new BN(0),
          baseFeeMode: 0
        },
        dynamicFee: null
      },
      collectFeeMode: 0,
      migrationOption: 1,
      activationType: 0,
      tokenType: 0,
      tokenDecimal: 9,
      migrationQuoteThreshold: new BN(0.01 * LAMPORTS_PER_SOL), // 0.01 SOL
      partnerLpPercentage: 0,
      partnerLockedLpPercentage: 50,
      creatorLpPercentage: 0,
      creatorLockedLpPercentage: 50,
      sqrtStartPrice: new BN("3141367320245630"),
      lockedVesting: { amountPerPeriod: new BN(0), cliffDurationFromMigrationTime: new BN(0), frequency: new BN(0), numberOfPeriod: new BN(0), cliffUnlockAmount: new BN(0) },
      migrationFeeOption: 6,
      tokenSupply: { preMigrationTokenSupply: new BN("1000000000000000000"), postMigrationTokenSupply: new BN("1000000000000000000") },
      creatorTradingFeePercentage: 50,
      tokenUpdateAuthority: 1,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { poolFeeBps: 400, collectFeeMode: 0, dynamicFee: 0 },
      padding: Array(7).fill(new BN(0)),
      curve: bagsCurve,
    };

    const tx = await dbcClient.partner.createConfig({
      config: configKeypair.publicKey,
      quoteMint: NATIVE_SOL_MINT,
      feeClaimer: adminKeypair.publicKey,
      leftoverReceiver: adminKeypair.publicKey,
      payer: adminKeypair.publicKey,
      ...configParams
    });
    tx.feePayer = adminKeypair.publicKey;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.sign(configKeypair, adminKeypair);

    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    await connection.confirmTransaction(signature, 'confirmed');

    return {
      success: true,
      configAddress: configKeypair.publicKey.toString(),
      signature,
      adminWallet: adminKeypair.publicKey.toString(),
      details: {
        migrationThreshold: '0.01 SOL',
        fee: '4% total (2% creator, 2% platform)',
        tokenSupply: '1B',
      }
    };
  } catch (error) {
    return { success: false, error: error?.message || 'Unknown error' };
  }
}

module.exports = { createInkwellConfigSpam };
