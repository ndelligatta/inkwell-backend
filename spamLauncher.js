const { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
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

async function getConnection() {
  let conn = new Connection(HELIUS_RPC || FALLBACK_RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60000 });
  try { await conn.getLatestBlockhash('confirmed'); return conn; } catch (_) {}
  conn = new Connection(FALLBACK_RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60000 });
  await conn.getLatestBlockhash('confirmed');
  return conn;
}

async function uploadImageAndMetadata(imageBase64, imageMime) {
  // Upload image if provided
  let imageUrl;
  if (imageBase64) {
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const ext = imageMime && imageMime.includes('png') ? 'png' : 'jpg';
    const imagePath = `posts/spam/spam-token-image-${Date.now()}.${ext}`;
    const { error: imgErr } = await supabase.storage.from('post-media').upload(imagePath, imageBuffer, { cacheControl: '3600', upsert: true, contentType: imageMime || 'image/png' });
    if (!imgErr) {
      const { data } = supabase.storage.from('post-media').getPublicUrl(imagePath);
      imageUrl = data.publicUrl;
    }
  }
  if (!imageUrl) {
    // Fallback to hosted asset if client didn't send image
    imageUrl = 'https://blockparty.fun/spam-bp.png';
  }

  const mintPlaceholder = 'SPAM';
  const metaJson = {
    name: 'Block Party',
    symbol: 'PARTY',
    description: 'Block Party — Join the party at https://blockparty.fun',
    image: imageUrl,
    attributes: [
      { trait_type: 'twitter', value: 'https://x.com/blockpartysol' },
      { trait_type: 'website', value: 'https://blockparty.fun' }
    ],
    properties: { files: [{ uri: imageUrl, type: imageMime || 'image/png' }], category: 'image', creators: [] },
    external_url: 'https://blockparty.fun',
    extensions: { twitter: 'https://x.com/blockpartysol', website: 'https://blockparty.fun' }
  };
  const metaPath = `posts/token-metadata-spam-${Date.now()}.json`;
  const { error: metaErr } = await supabase.storage.from('post-media').upload(metaPath, Buffer.from(JSON.stringify(metaJson, null, 2)), { cacheControl: '3600', upsert: true, contentType: 'application/json' });
  if (metaErr) throw metaErr;
  const { data: metaUrlData } = supabase.storage.from('post-media').getPublicUrl(metaPath);
  return metaUrlData.publicUrl;
}

async function launchSpamToken({ imageBase64, imageMime }) {
  const profilePriv = (process.env.PROFILE_TOKEN_WALLET_PRIVATE_KEY || '').trim();
  if (!profilePriv) return { success: false, error: 'PROFILE_TOKEN_WALLET_PRIVATE_KEY not configured' };
  // Config selection with safe fallbacks:
  // 1) SPAM_CONFIG_PUBKEY (preferred)
  // 2) DBC_CONFIG_PUBKEY (default app config)
  // 3) Signer public key (as instructed)
  let configStr = (process.env.SPAM_CONFIG_PUBKEY || process.env.DBC_CONFIG_PUBKEY || '').trim();
  let useSignerAsConfig = false;
  if (!configStr) {
    try {
      const signerTmp = Keypair.fromSecretKey(bs58.decode(profilePriv));
      configStr = signerTmp.publicKey.toBase58();
      useSignerAsConfig = true;
    } catch (e) {
      return { success: false, error: 'SPAM_CONFIG_PUBKEY not configured and failed to derive from profile wallet' };
    }
  }

  try {
    const connection = await getConnection();
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');

    // Signer is the profile token wallet
    const signer = Keypair.fromSecretKey(bs58.decode(profilePriv));

    // Upload metadata
    const metadataUri = await uploadImageAndMetadata(imageBase64, imageMime);

    // Create pool with first buy (0.01 SOL)
    const configPk = new PublicKey(configStr);
    console.log('[spam-launch] Using config:', configPk.toBase58(), useSignerAsConfig ? '(derived from signer pubkey)' : '');
    const tokenMintKP = Keypair.generate();
    const createPoolTx = await dbcClient.pool.createPool({
      baseMint: tokenMintKP.publicKey,
      config: configPk,
      name: 'Block Party',
      symbol: 'PARTY',
      uri: metadataUri,
      payer: signer.publicKey,
      poolCreator: signer.publicKey,
    });

    // Add priority + pool instructions
    const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500000 });
    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 });
    const tx = new Transaction();
    tx.add(priorityFeeIx);
    tx.add(computeLimitIx);
    tx.add(...createPoolTx.instructions);
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(tokenMintKP, signer);
    const sig1 = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(sig1, 'confirmed');

    // Swap buy 0.01 SOL
    const poolAddress = (await dbcClient.state.getPoolByBaseMint(tokenMintKP.publicKey)).pool.toString();
    const buyTx = await dbcClient.pool.swap({
      owner: signer.publicKey,
      pool: new PublicKey(poolAddress),
      amountIn: new BN(Math.floor(0.01 * 1e9)),
      minimumAmountOut: new BN(0),
      swapBaseForQuote: false,
      referralTokenAccount: null,
      payer: signer.publicKey
    });
    const buyPriority = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 });
    const buyLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 });
    const btx = new Transaction();
    btx.add(buyPriority); btx.add(buyLimit); btx.add(...buyTx.instructions);
    btx.feePayer = signer.publicKey;
    btx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    btx.sign(signer);
    const sig2 = await connection.sendRawTransaction(btx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(sig2, 'confirmed');

    return {
      success: true,
      mintAddress: tokenMintKP.publicKey.toBase58(),
      poolAddress,
      transactionSignature: sig2,
      solscanUrl: `https://solscan.io/tx/${sig2}`
    };
  } catch (error) {
    return { success: false, error: error?.message || 'Failed to launch spam token' };
  }
}

module.exports = { launchSpamToken };
