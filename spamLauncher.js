const { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { DynamicBondingCurveClient, deriveDbcPoolAddress } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const BN = require('bn.js');
const bs58 = require('bs58').default;
const { createClient } = require('@supabase/supabase-js');

// Prefer IPv4 first
try { const dns = require('node:dns'); dns.setDefaultResultOrder && dns.setDefaultResultOrder('ipv4first'); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null;
const FALLBACK_RPC = 'https://api.mainnet-beta.solana.com';
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

async function getConnection() {
  let conn = new Connection(HELIUS_RPC || FALLBACK_RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60000 });
  try { await conn.getLatestBlockhash('confirmed'); return conn; } catch (_) {}
  conn = new Connection(FALLBACK_RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60000 });
  await conn.getLatestBlockhash('confirmed');
  return conn;
}

const { uploadMetadataReplica } = require('./metadataUploaderReplica');

async function uploadImageAndMetadataForMint(mintAddress, imageBase64) {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new Error('imageBase64 is required');
  }
  const replicaMeta = {
    name: 'Block Party',
    symbol: 'PARTY',
    description: 'Block Party — Join the party at https://blockparty.fun',
    website: 'https://blockparty.fun',
    twitter: 'https://x.com/blockpartysol',
    image: Buffer.from(imageBase64, 'base64'),
    imageType: 'image/png'
  };
  return await uploadMetadataReplica(replicaMeta, mintAddress);
}

async function launchSpamToken({ imageBase64, imageMime }) {
  const profilePriv = (process.env.PROFILE_TOKEN_WALLET_PRIVATE_KEY || '').trim();
  if (!profilePriv) return { success: false, error: 'PROFILE_TOKEN_WALLET_PRIVATE_KEY not configured' };
  // Config selection with safe fallbacks:
  // 1) SPAM_CONFIG_PUBKEY (preferred)
  // 2) DBC_CONFIG_PUBKEY (default app config)
  // 3) Signer public key (as instructed)
  // Strictly use the provided hard-coded config (0.01 SOL threshold)
  const configStr = 'FBGD1Jq887Z2KPSiG88mUpRBKLHhYFm7vihXjB3TuBYf';

  try {
    const connection = await getConnection();
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');

    // Signer is the profile token wallet
    const signer = Keypair.fromSecretKey(bs58.decode(profilePriv));

    // Prepare mint first for deterministic storage paths
    const tokenMintKP = Keypair.generate();
    const mintAddress = tokenMintKP.publicKey.toBase58();
    // Upload metadata (image + json) with mint-specific filenames (mirrors main flow)
    const { metadataUrl, imageUrl } = await uploadImageAndMetadataForMint(mintAddress, imageBase64);

    // Create pool + first buy in the same transaction
    const configPk = new PublicKey(configStr);
    console.log('[spam-launch] Using config:', configPk.toBase58());
    let poolInstructions = [];
    let buyInstructions = [];
    try {
      const { createPoolTx, swapBuyTx } = await dbcClient.pool.createPoolWithFirstBuy({
        createPoolParam: {
          baseMint: new PublicKey(mintAddress),
          config: configPk,
          name: 'Block Party',
          symbol: 'PARTY',
          uri: metadataUrl,
          payer: signer.publicKey,
          poolCreator: signer.publicKey,
        },
        firstBuyParam: {
          buyer: signer.publicKey,
          buyAmount: new BN(Math.floor(0.01 * 1e9)),
          minimumAmountOut: new BN(1),
          referralTokenAccount: null,
        },
      });
      poolInstructions = createPoolTx.instructions;
      if (swapBuyTx) buyInstructions = swapBuyTx.instructions;
    } catch (e) {
      const createPoolTx = await dbcClient.pool.createPool({
        baseMint: new PublicKey(mintAddress),
        config: configPk,
        name: 'Block Party',
        symbol: 'PARTY',
          uri: metadataUrl,
        payer: signer.publicKey,
        poolCreator: signer.publicKey,
      });
      poolInstructions = createPoolTx.instructions;
    }

    const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500000 });
    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 });
    const tx = new Transaction();
    tx.add(priorityFeeIx);
    tx.add(computeLimitIx);
    tx.add(...poolInstructions);
    if (buyInstructions.length > 0) tx.add(...buyInstructions);
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(tokenMintKP, signer);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(sig, 'confirmed');

    // Derive pool address deterministically (avoid race with on-chain query)
    const poolAddress = deriveDbcPoolAddress(NATIVE_MINT, new PublicKey(mintAddress), configPk).toString();
    return { success: true, mintAddress, poolAddress, transactionSignature: sig, solscanUrl: `https://solscan.io/tx/${sig}`, metadataUrl, imageUrl };
  } catch (error) {
    return { success: false, error: error?.message || 'Failed to launch spam token' };
  }
}

module.exports = { launchSpamToken };
