// Server uses environment variables from Railway, not .env file

// Log environment variables to debug
console.log('Environment variables loaded:');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET' : 'NOT SET');
console.log('SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'SET (hidden)' : 'NOT SET');
console.log('DBC_CONFIG_PUBKEY:', process.env.DBC_CONFIG_PUBKEY || 'NOT SET');
console.log('PORT:', process.env.PORT || '3001');

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

// Import AFTER dotenv is loaded
const { 
  launchTokenDBC, 
  getUserDevWallet, 
  validateMetadata,
  prepareLaunchTokenTransaction,
  broadcastSignedTransaction
} = require('./tokenLauncherImproved');
const { createInkwellConfig } = require('./createConfig');
const { claimPoolFees, getPoolFeeMetrics } = require('./claimPlatformFees');
const { 
  claimCreatorFees, 
  claimAllCreatorFees, 
  checkAvailableCreatorFees,
  prepareCreatorClaimTxDBC,
  prepareCreatorClaimTxDammV2,
  checkPoolMigrationOfficial,
  getMigratedPoolAddress,
  broadcastSignedClaimTx
} = require('./claimCreatorFees');
const { SystemProgram, LAMPORTS_PER_SOL, Transaction, PublicKey, Keypair } = require('@solana/web3.js');
const { parsePrivateKey } = require('./tokenLauncherImproved');
const { getLifetimeFees, updateAllPoolsLifetimeFees } = require('./getLifetimeFees');
const { updateUserLifetimeFees, updateAllUsersLifetimeFees } = require('./updateUserLifetimeFees');
const authRoutes = require('./routes/auth');

// START KEYPAIR WORKER IN BACKGROUND
console.log('\n🚀🚀🚀 STARTING KEYPAIR GENERATION WORKER 🚀🚀🚀');
try {
  require('./keypairWorker'); // This starts the worker automatically
  console.log('🚀 Keypair worker started successfully!\n');
} catch (error) {
  console.error('❌ FAILED TO START KEYPAIR WORKER:', error);
  console.error('Error details:', error.message);
  console.error('Stack:', error.stack);
}

const app = express();
const PORT = process.env.PORT || 3001;
// Strict Helius RPC for fee-claim flows
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null;

// Helper: create a Helius connection and verify blockhash with simple retry
async function getHeliusConnectionOrThrow() {
  if (!HELIUS_RPC) throw new Error('HELIUS_API_KEY not configured');
  const { Connection } = require('@solana/web3.js');
  const connection = new Connection(HELIUS_RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60000 });
  const maxRetries = 3;
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await connection.getLatestBlockhash('confirmed');
      return connection;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(`Helius RPC unavailable: ${lastErr?.message || lastErr}`);
}

// CORS configuration - allow specific origins
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:3000',
      'https://blockparty.fun',
      'https://www.blockparty.fun',
      'https://inkwell-feed.netlify.app'
    ];
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all origins for now
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};

// Middleware
app.use(cors(corsOptions));

// Additional CORS headers for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Increase JSON/body limits to accommodate base64 images (GIF thumbnails)
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Configure multer for file uploads (in memory)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB limit for multipart uploads
});

// Auth routes
app.use('/api/auth', authRoutes);

// ===================== TikTok OAuth + Status =====================
// Hardcode Sandbox credentials for testing (override env)
const TIKTOK_CLIENT_KEY = 'sbaw5wpct4kow6cj4t';
const TIKTOK_CLIENT_SECRET = 'n0XT6OhiGUHgn0U1chPnPB0Bhd7Ekcv6';
const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI; // e.g., https://api.blockparty.fun/api/tiktok/auth/callback
// Hardcode scopes for simplicity
const TIKTOK_SCOPES = 'user.info.basic,video.publish';
const TIKTOK_AUTH_BASE = process.env.TIKTOK_AUTH_BASE || 'https://www.tiktok.com';
const TIKTOK_API_BASE = process.env.TIKTOK_API_BASE || 'https://open.tiktokapis.com';
const TIKTOK_STATE_SECRET = process.env.TIKTOK_STATE_SECRET || null;

function hmacSign(payload) {
  if (!TIKTOK_STATE_SECRET) return null;
  return crypto.createHmac('sha256', TIKTOK_STATE_SECRET).update(payload).digest('hex');
}

function makeState(userId) {
  const data = { userId, ts: Date.now(), nonce: crypto.randomBytes(8).toString('hex') };
  const json = JSON.stringify(data);
  const b64 = Buffer.from(json).toString('base64url');
  const sig = hmacSign(b64);
  return sig ? `${b64}.${sig}` : b64;
}

function parseAndVerifyState(state) {
  try {
    if (!state) return null;
    if (!TIKTOK_STATE_SECRET) {
      const json = Buffer.from(state, 'base64url').toString('utf8');
      return JSON.parse(json);
    }
    const [b64, sig] = state.split('.')
    if (!b64 || !sig) return null;
    const expect = hmacSign(b64);
    if (expect !== sig) return null;
    const json = Buffer.from(b64, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function supabaseAdmin() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Initiate TikTok OAuth
app.get('/api/tiktok/auth/initiate', async (req, res) => {
  try {
    if (!TIKTOK_CLIENT_KEY || !TIKTOK_REDIRECT_URI) {
      return res.status(500).json({ success: false, error: 'TikTok OAuth not configured' });
    }
    const userId = (req.query.userId || '').toString();
    if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });
    const state = makeState(userId);
    const params = new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      response_type: 'code',
      scope: TIKTOK_SCOPES,
      redirect_uri: TIKTOK_REDIRECT_URI,
      state
    });
    const url = `${TIKTOK_AUTH_BASE}/v2/auth/authorize/?${params.toString()}`;
    res.redirect(url);
  } catch (err) {
    console.error('TikTok initiate error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal error' });
  }
});

// TikTok OAuth callback
app.get('/api/tiktok/auth/callback', async (req, res) => {
  try {
    const code = (req.query.code || '').toString();
    const state = (req.query.state || '').toString();
    if (!code || !state) return res.status(400).send('Missing code/state');
    const parsed = parseAndVerifyState(state);
    if (!parsed || !parsed.userId) return res.status(400).send('Invalid state');
    const userId = parsed.userId;

    // Exchange code → access/refresh tokens (TikTok requires x-www-form-urlencoded)
    const tokenUrl = `${TIKTOK_API_BASE}/v2/oauth/token/`;
    const form = new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      client_secret: TIKTOK_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: TIKTOK_REDIRECT_URI
    });
    const tokResp = await axios.post(tokenUrl, form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const tok = tokResp.data || {};
    if (!tok.access_token) {
      console.error('TikTok token exchange failed:', tok);
      return res.status(502).send('TikTok token exchange failed');
    }
    const accessToken = tok.access_token;
    const refreshToken = tok.refresh_token || null;
    const expiresIn = Number(tok.expires_in || 0);
    const openId = tok.open_id || null;
    const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    // Fetch creator info (optional) for username/avatar
    let username = null, avatarUrl = null;
    try {
      const infoResp = await axios.post(
        `${TIKTOK_API_BASE}/v2/post/publish/creator_info/query/`,
        {},
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
      );
      const info = infoResp.data || {};
      if (info.data) {
        username = info.data.creator_username || null;
        avatarUrl = info.data.creator_avatar_url || null;
      }
    } catch (e) {
      console.warn('creator_info query failed (non-fatal):', e?.response?.data || e?.message || e);
    }

    // Persist tokens + identity to users table
    try {
      const sb = supabaseAdmin();
      const { error } = await sb
        .from('users')
        .update({
          tiktok_open_id: openId,
          tiktok_access_token: accessToken,
          tiktok_refresh_token: refreshToken,
          tiktok_token_expires_at: tokenExpiresAt,
          tiktok_scopes: TIKTOK_SCOPES,
          tiktok_username: username,
          tiktok_avatar_url: avatarUrl,
          updated_at: new Date().toISOString()
        })
        .eq('id', userId);
      if (error) {
        console.error('Supabase update error (TikTok):', error);
        return res.status(500).send('Failed to save TikTok tokens');
      }
    } catch (dbErr) {
      console.error('Supabase error (TikTok):', dbErr);
      return res.status(500).send('Failed to save TikTok tokens');
    }

    const redirectBack = 'https://blockparty.fun/settings?connected=tiktok';
    res.redirect(302, redirectBack);
  } catch (err) {
    console.error('TikTok callback error:', err?.response?.data || err?.message || err);
    res.status(500).send('Internal error');
  }
});

// Lightweight connection status for UI
app.get('/api/tiktok/status', async (req, res) => {
  try {
    const userId = (req.query.userId || '').toString();
    if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from('users')
      .select('tiktok_open_id, tiktok_username, tiktok_avatar_url, tiktok_token_expires_at')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    const connected = !!(data && (data.tiktok_open_id || data.tiktok_token_expires_at || data.tiktok_username));
    res.json({ success: true, connected, username: data?.tiktok_username || null, avatar_url: data?.tiktok_avatar_url || null });
  } catch (err) {
    console.error('TikTok status error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal error' });
  }
});

// Disconnect and wipe TikTok tokens
app.post('/api/tiktok/auth/disconnect', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });
    const sb = supabaseAdmin();
    const { error } = await sb
      .from('users')
      .update({
        tiktok_open_id: null,
        tiktok_access_token: null,
        tiktok_refresh_token: null,
        tiktok_token_expires_at: null,
        tiktok_scopes: null,
        tiktok_username: null,
        tiktok_avatar_url: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('TikTok disconnect error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal error' });
  }
});

// Post a video to TikTok for a linked user (Direct Post with PULL_FROM_URL, fallback FILE_UPLOAD)
app.post('/api/tiktok/post-video', async (req, res) => {
  try {
    const { userId, videoUrl, title, privacy, coverTsMs } = req.body || {};
    if (!userId || !videoUrl || !title) {
      return res.status(400).json({ success: false, error: 'userId, videoUrl, and title are required' });
    }

    const sb = supabaseAdmin();
    // 1) Load TikTok tokens
    const { data: user, error: uerr } = await sb
      .from('users')
      .select('tiktok_access_token, tiktok_refresh_token, tiktok_token_expires_at')
      .eq('id', userId)
      .maybeSingle();
    if (uerr || !user || !user.tiktok_access_token) {
      return res.status(400).json({ success: false, error: 'User does not have a linked TikTok account' });
    }

    let accessToken = user.tiktok_access_token;
    let refreshToken = user.tiktok_refresh_token;
    const expIso = user.tiktok_token_expires_at;
    const expired = expIso ? Date.now() > new Date(expIso).getTime() - 60_000 : false;

    // 2) Refresh if needed
    if (expired && refreshToken) {
      try {
        const form = new URLSearchParams({
          client_key: TIKTOK_CLIENT_KEY,
          client_secret: TIKTOK_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        });
        const r = await axios.post(`${TIKTOK_API_BASE}/v2/oauth/token/`, form.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        const tok = r.data || {};
        if (tok.access_token) {
          accessToken = tok.access_token;
          refreshToken = tok.refresh_token || refreshToken;
          const expiresIn = Number(tok.expires_in || 0);
          const newExp = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : expIso;
          await sb.from('users').update({
            tiktok_access_token: accessToken,
            tiktok_refresh_token: refreshToken,
            tiktok_token_expires_at: newExp,
            updated_at: new Date().toISOString(),
          }).eq('id', userId);
        }
      } catch (e) {
        // If refresh fails, proceed with existing token (may still be valid) – do not block main flow
        console.warn('TikTok token refresh failed:', e?.response?.data || e?.message || e);
      }
    }

    // 3) Query creator info (optional but recommended)
    try {
      await axios.post(`${TIKTOK_API_BASE}/v2/post/publish/creator_info/query/`, {}, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' }
      });
    } catch (e) {
      console.warn('creator_info query failed (non-fatal):', e?.response?.data || e?.message || e);
    }

    const postInfo = {
      title: String(title).slice(0, 2200),
      // Sandbox/unaudited clients must post to private accounts
      privacy_level: privacy || 'SELF_ONLY',
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: Number.isFinite(coverTsMs) ? Number(coverTsMs) : 1000,
    };

    // 4) Try PULL_FROM_URL first
    try {
      const initResp = await axios.post(`${TIKTOK_API_BASE}/v2/post/publish/video/init/`, {
        post_info: postInfo,
        source_info: { source: 'PULL_FROM_URL', video_url: videoUrl }
      }, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' }
      });
      const init = initResp.data || {};
      if (init?.data?.publish_id) {
        return res.json({ success: true, method: 'PULL_FROM_URL', publish_id: init.data.publish_id });
      }
    } catch (e) {
      console.warn('PULL_FROM_URL failed, will try FILE_UPLOAD:', e?.response?.data || e?.message || e);
    }

    // 5) FILE_UPLOAD fallback
    let size = 0;
    let contentType = 'video/mp4';
    try {
      const head = await axios.head(videoUrl);
      if (head.headers['content-length']) size = parseInt(head.headers['content-length'], 10) || 0;
      if (head.headers['content-type']) contentType = head.headers['content-type'];
    } catch {}
    if (!size) {
      try {
        const head2 = await axios.get(videoUrl, { responseType: 'stream' });
        if (head2.headers['content-length']) size = parseInt(head2.headers['content-length'], 10) || 0;
        if (head2.headers['content-type']) contentType = head2.headers['content-type'];
        head2.data.destroy?.(); // close stream
      } catch (e) {
        return res.status(200).json({ success: false, error: 'Could not determine video size for upload' });
      }
    }

    const chunkSize = size; // single-chunk upload
    const totalChunks = 1;
    const initFile = await axios.post(`${TIKTOK_API_BASE}/v2/post/publish/video/init/`, {
      post_info: postInfo,
      source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: totalChunks }
    }, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' }
    });
    const initData = initFile.data || {};
    const uploadUrl = initData?.data?.upload_url;
    const publishId = initData?.data?.publish_id;
    if (!uploadUrl || !publishId) {
      return res.status(200).json({ success: false, error: 'TikTok FILE_UPLOAD init failed' });
    }

    // Stream upload from our videoUrl to TikTok upload_url
    const src = await axios.get(videoUrl, { responseType: 'stream' });
    await axios.put(uploadUrl, src.data, {
      headers: {
        'Content-Range': `bytes 0-${size - 1}/${size}`,
        'Content-Type': contentType || 'video/mp4'
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    return res.json({ success: true, method: 'FILE_UPLOAD', publish_id: publishId });
  } catch (err) {
    const payload = err?.response?.data || { message: err?.message || 'Unknown error' };
    console.error('TikTok post-video error:', payload);
    // Do not surface 5xx to keep main app flow clean
    res.status(200).json({ success: false, error: payload });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Inkwell backend is running' });
});

// Convert a video URL to a small high-quality GIF using system ffmpeg with a palette (two-pass)
app.post('/api/media/convert-gif', async (req, res) => {
  const MAX_BYTES = 10 * 1024 * 1024; // 10MB
  const TIMEOUT_MS = 20000; // 20s per ffmpeg step

  const safeError = (code, msg) => res.status(code).json({ success: false, error: msg });

  try {
    const videoUrl = (req.body && req.body.videoUrl) ? String(req.body.videoUrl) : '';
    if (!videoUrl) return safeError(400, 'videoUrl is required');
    if (!videoUrl.startsWith('https://')) return safeError(400, 'Only https URLs are allowed');
    try {
      const u = new URL(videoUrl);
      const host = u.hostname;
      if (
        host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
        host.startsWith('169.254.')
      ) {
        return safeError(400, 'Disallowed host');
      }
    } catch (_) {
      return safeError(400, 'Invalid URL');
    }

    // HEAD check for content-type and length (best-effort)
    try {
      const head = await axios.head(videoUrl, { timeout: 8000, validateStatus: () => true });
      const type = head.headers['content-type'] || '';
      const len = parseInt(head.headers['content-length'] || '0', 10);
      if (type && !type.startsWith('video/')) {
        return safeError(400, 'URL is not a video');
      }
      if (len && len > MAX_BYTES) {
        return safeError(400, 'Video is too large (max 10MB)');
      }
    } catch (e) {
      // Ignore HEAD errors; continue and enforce during download
    }

    // Download to /tmp
    const tmpIn = path.join('/tmp', `in-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
    const tmpPalette = path.join('/tmp', `palette-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    const tmpOut = path.join('/tmp', `out-${Date.now()}-${Math.random().toString(36).slice(2)}.gif`);
    const tmpPng = path.join('/tmp', `thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

    const cleanup = () => {
      [tmpIn, tmpPalette, tmpOut, tmpPng].forEach((p) => {
        try { fs.existsSync(p) && fs.unlinkSync(p); } catch (_) {}
      });
    };

    try {
      const resp = await axios.get(videoUrl, { responseType: 'stream', timeout: 12000 });
      const ws = fs.createWriteStream(tmpIn);
      let downloaded = 0;
      await new Promise((resolve, reject) => {
        resp.data.on('data', (chunk) => {
          downloaded += chunk.length;
          if (downloaded > MAX_BYTES) {
            resp.data.destroy();
            ws.destroy();
            reject(new Error('Video exceeds 10MB limit'));
          }
        });
        resp.data.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        resp.data.pipe(ws);
      });
    } catch (e) {
      cleanup();
      return safeError(400, e.message || 'Failed to download video');
    }

    // Helper to run ffmpeg with timeout
    const runFfmpeg = (args, timeoutMs) => new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { if (stderr.length < 100000) stderr += d.toString(); });
      const to = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
      child.on('error', (err) => { clearTimeout(to); reject(err); });
      child.on('close', (code, signal) => {
        clearTimeout(to);
        if (code === 0) resolve({ code });
        else reject(new Error(`ffmpeg failed: code=${code} signal=${signal} stderr=${stderr.slice(0,1500)}`));
      });
    });

    try {
      // Pass 1: palette generation
      await runFfmpeg([
        '-nostdin','-y','-threads','1','-t','4',
        '-i', tmpIn,
        '-vf', 'fps=12,scale=512:-1:flags=lanczos,palettegen=stats_mode=diff',
        tmpPalette
      ], TIMEOUT_MS);

      // Pass 2: apply palette
      await runFfmpeg([
        '-nostdin','-y','-threads','1','-t','4',
        '-i', tmpIn,
        '-i', tmpPalette,
        '-lavfi', 'fps=12,scale=512:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
        tmpOut
      ], TIMEOUT_MS);

      const gifBuffer = fs.readFileSync(tmpOut);
      const gifBase64 = gifBuffer.toString('base64');
      cleanup();
      return res.status(200).json({ success: true, gifBase64, gifMime: 'image/gif' });
    } catch (e) {
      console.error('GIF conversion failed, attempting PNG fallback:', e?.message || e);
      try {
        // Fallback: first-frame PNG thumbnail
        await runFfmpeg([
          '-nostdin','-y','-threads','1',
          '-ss','0.5','-i', tmpIn,
          '-vframes','1',
          '-vf','scale=512:-1:flags=lanczos',
          tmpPng
        ], TIMEOUT_MS);
        const pngBuffer = fs.readFileSync(tmpPng);
        const pngBase64 = pngBuffer.toString('base64');
        cleanup();
        return res.status(200).json({ success: true, gifBase64: pngBase64, gifMime: 'image/png' });
      } catch (e2) {
        console.error('PNG fallback failed:', e2?.message || e2);
        cleanup();
        return safeError(500, 'Conversion failed');
      }
    }
  } catch (error) {
    console.error('Error converting video to GIF:', error);
    return res.status(500).json({ success: false, error: error.message || 'Conversion failed' });
  }
});

// Main token launch endpoint
app.post('/api/launch-token', upload.single('image'), async (req, res) => {
  try {
    const { 
      name, 
      symbol, 
      description, 
      website, 
      twitter, 
      instagram,
      initialBuyAmount,
      userId,
      userPrivateKey // Dev wallet private key
    } = req.body;

    // Validate required fields
    if (!name || !symbol || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, symbol, and userId are required'
      });
    }

    // Get user's dev wallet if not provided
    let privateKey = userPrivateKey;
    if (!privateKey) {
      privateKey = await getUserDevWallet(userId);
      if (!privateKey) {
        return res.status(400).json({
          success: false,
          error: 'User dev wallet not found. Please generate a dev wallet first.'
        });
      }
    }

    // Prepare metadata - ensure website and twitter are properly handled
    const metadata = {
      name: name.trim(),
      symbol: symbol.trim(),
      description: description?.trim() || '',
      // Only include website/twitter if they have actual content
      website: website?.trim() || undefined,
      // ALWAYS include twitter - use BlockParty as fallback
      twitter: twitter?.trim() || 'https://x.com/blockpartysol',
      instagram: instagram?.trim() || undefined,
      initialBuyAmount: parseFloat(initialBuyAmount) || 0.01
    };

    // Handle image upload if provided
    if (req.file) {
      // Convert file buffer to base64
      metadata.image = req.file.buffer;
      metadata.imageType = req.file.mimetype;
    } else if (req.body.imageBase64) {
      // Handle base64 image from request body
      metadata.image = req.body.imageBase64;
      metadata.imageType = req.body.imageType || 'image/png';
    }

    // Launch token
    const result = await launchTokenDBC(metadata, userId, privateKey);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }

  } catch (error) {
    console.error('Error in /api/launch-token:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Prepare a transaction for client-side signing with Privy
app.post('/api/launch-token/prepare', upload.single('image'), async (req, res) => {
  try {
    const { 
      name, symbol, description, website, twitter, instagram, initialBuyAmount,
      userId, walletAddress
    } = req.body;

    if (!name || !symbol || !userId || !walletAddress) {
      return res.status(400).json({ success: false, error: 'name, symbol, userId, and walletAddress are required' });
    }

    const metadata = {
      name: name.trim(),
      symbol: symbol.trim(),
      description: description?.trim() || '',
      website: website?.trim() || undefined,
      twitter: twitter?.trim() || 'https://x.com/blockpartysol',
      instagram: instagram?.trim() || undefined,
      initialBuyAmount: parseFloat(initialBuyAmount) || 0.01
    };

    // Handle image (optional)
    if (req.file) {
      metadata.image = req.file.buffer.toString('base64');
      metadata.imageType = req.file.mimetype;
    } else if (req.body.imageBase64) {
      metadata.image = req.body.imageBase64;
      metadata.imageType = req.body.imageType || 'image/png';
    }

    const result = await prepareLaunchTokenTransaction(metadata, userId, walletAddress);
    const status = result.success ? 200 : 400;
    res.status(status).json(result);
  } catch (error) {
    console.error('Error in /api/launch-token/prepare:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

// Broadcast a fully-signed transaction produced by the client (Privy)
app.post('/api/launch-token/broadcast', async (req, res) => {
  try {
    const { signedTxBase64, userId, mintAddress, poolAddress, metadataName, metadataSymbol, metadataUri, usedKeypairId } = req.body;
    const result = await broadcastSignedTransaction({ signedTxBase64, userId, mintAddress, poolAddress, metadataName, metadataSymbol, metadataUri, usedKeypairId });
    const status = result.success ? 200 : 400;
    res.status(status).json(result);
  } catch (error) {
    console.error('Error in /api/launch-token/broadcast:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

// SPAM TEST endpoint - hardcoded values for testing
app.post('/api/spam-launch-token', upload.single('image'), async (req, res) => {
  try {
    // HARDCODED VALUES FOR TESTING
    const HARDCODED_PRIVATE_KEY = 'TgWKJ6WPfhPiG9mV0IuhTOruLvNwa+FkEAzKSzBpMSp+CmrIr6TOs7SMwEicbv1ePBl4XBRDtm0czkKhl9Msdw==';
    const HARDCODED_USER_ID = 'spam-test-user'; // Fake user ID for testing
    
    // Hardcoded metadata
    const metadata = {
      name: 'PARTY',
      symbol: 'PARTY',
      description: 'Transforming the way that content is monetized. BlockParty is the first social media platform to tokenize content, allowing you to get paid every time you post.',
      website: 'https://blockparty.fun/',
      twitter: 'https://x.com/blockpartysol',
      initialBuyAmount: 0.01
    };

    // Read the hardcoded image file
    const fs = require('fs');
    const path = require('path');
    const imagePath = 'c:\\Users\\james\\Downloads\\Untitled design (11).png';
    
    try {
      if (fs.existsSync(imagePath)) {
        const imageBuffer = fs.readFileSync(imagePath);
        metadata.image = imageBuffer;
        metadata.imageType = 'image/png';
        console.log('Loaded hardcoded image from:', imagePath);
      } else {
        console.warn('Hardcoded image not found at:', imagePath);
        // Continue without image
      }
    } catch (imageError) {
      console.error('Error loading hardcoded image:', imageError);
      // Continue without image
    }

    console.log('=== SPAM LAUNCH TOKEN ===');
    console.log('Using hardcoded values:');
    console.log('Name:', metadata.name);
    console.log('Symbol:', metadata.symbol);
    console.log('Website:', metadata.website);
    console.log('Twitter:', metadata.twitter);
    console.log('Initial Buy:', metadata.initialBuyAmount);
    console.log('Image loaded:', !!metadata.image);

    // Launch token using the exact same function as regular endpoint
    const result = await launchTokenDBC(metadata, HARDCODED_USER_ID, HARDCODED_PRIVATE_KEY);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }

  } catch (error) {
    console.error('Error in /api/spam-launch-token:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Alternative endpoint for launching with metadata passed directly
app.post('/api/launch-token-json', async (req, res) => {
  try {
    const { 
      metadata,
      userId,
      userPrivateKey // Dev wallet private key
    } = req.body;

    // Validate required fields
    if (!metadata?.name || !metadata?.symbol || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: metadata.name, metadata.symbol, and userId are required'
      });
    }

    // Get user's dev wallet if not provided
    let privateKey = userPrivateKey;
    if (!privateKey) {
      privateKey = await getUserDevWallet(userId);
      if (!privateKey) {
        return res.status(400).json({
          success: false,
          error: 'User dev wallet not found. Please generate a dev wallet first.'
        });
      }
    }

    // Launch token
    const result = await launchTokenDBC(metadata, userId, privateKey);

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }

  } catch (error) {
    console.error('Error in /api/launch-token-json:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Get user's dev wallet endpoint
app.get('/api/dev-wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const privateKey = await getUserDevWallet(userId);
    
    if (privateKey) {
      // Only return public key for security
      const { Keypair } = require('@solana/web3.js');
      const bs58 = require('bs58');
      
      let publicKey;
      try {
        const secretKey = Buffer.from(privateKey, 'base64');
        const keypair = Keypair.fromSecretKey(secretKey);
        publicKey = keypair.publicKey.toString();
      } catch (e) {
        try {
          const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
          publicKey = keypair.publicKey.toString();
        } catch (e2) {
          const keyArray = JSON.parse(privateKey);
          const keypair = Keypair.fromSecretKey(new Uint8Array(keyArray));
          publicKey = keypair.publicKey.toString();
        }
      }
      
      res.json({
        success: true,
        publicKey,
        hasDevWallet: true
      });
    } else {
      res.json({
        success: false,
        hasDevWallet: false,
        error: 'Dev wallet not found for user'
      });
    }
  } catch (error) {
    console.error('Error getting dev wallet:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Create new DBC config endpoint - protected with same auth as fee claiming
app.post('/api/create-config', async (req, res) => {
  try {
    console.log('====== CREATE CONFIG ENDPOINT ======');
    console.log('Request from:', req.headers.origin || 'Unknown origin');
    console.log('Authorization:', req.headers.authorization ? 'Present' : 'Missing');
    
    // Use same authentication as fee claiming endpoint
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${process.env.ADMIN_AUTH_TOKEN || 'admin-secret'}`) {
      console.error('Unauthorized request - missing or invalid auth token');
      return res.status(401).json({
        success: false,
        error: 'Unauthorized. Admin authentication required.'
      });
    }
    
    console.log('Creating new DBC config...');
    
    // Create the config using the same admin wallet as fee claiming
    const result = await createInkwellConfig();
    
    console.log('Config creation result:', result.success ? 'SUCCESS' : 'FAILED');
    if (!result.success) {
      console.error('Config creation failed:', result.error);
    } else {
      console.log('New config address:', result.configAddress);
    }
    
    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }
    
  } catch (error) {
    console.error('====== ERROR IN CONFIG ENDPOINT ======');
    console.error('Error:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      details: error.toString()
    });
  }
});

// Claim platform fees endpoint
app.post('/api/claim-platform-fees', async (req, res) => {
  try {
    console.log('====== CLAIM PLATFORM FEES ENDPOINT ======');
    console.log('Request from:', req.headers.origin || 'Unknown origin');
    console.log('Authorization:', req.headers.authorization ? 'Present' : 'Missing');
    
    // This endpoint should be protected
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${process.env.ADMIN_AUTH_TOKEN || 'admin-secret'}`) {
      console.error('Unauthorized request - missing or invalid auth token');
      return res.status(401).json({
        success: false,
        error: 'Unauthorized. Admin authentication required.'
      });
    }
    
    const { poolAddress, poolData } = req.body;
    console.log('Pool address:', poolAddress);
    console.log('Pool data:', poolData ? 'Provided' : 'Not provided');
    
    if (!poolAddress) {
      return res.status(400).json({
        success: false,
        error: 'Pool address is required'
      });
    }
    
    console.log('Starting fee claim process...');
    // Claim fees from the specified pool
    const result = await claimPoolFees(poolAddress, poolData || {});
    
    console.log('Claim result:', result.success ? 'SUCCESS' : 'FAILED');
    if (!result.success) {
      console.error('Claim failed:', result.error);
    }
    
    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }
    
  } catch (error) {
    console.error('====== ERROR IN CLAIM ENDPOINT ======');
    console.error('Error:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      details: error.toString()
    });
  }
});

// Get pool fee metrics endpoint
app.get('/api/pool-fees/:poolAddress', async (req, res) => {
  try {
    const { poolAddress } = req.params;
    
    if (!poolAddress) {
      return res.status(400).json({
        success: false,
        error: 'Pool address is required'
      });
    }
    
    // Get fee metrics for the pool
    const result = await getPoolFeeMetrics(poolAddress);
    
    res.status(200).json(result);
    
  } catch (error) {
    console.error('Error in /api/pool-fees:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Verify PIN endpoint for admin pages
app.post('/api/verify-pin', async (req, res) => {
  try {
    const { pin } = req.body;
    
    if (!pin) {
      return res.status(400).json({
        success: false,
        error: 'PIN is required'
      });
    }
    
    // Get the PIN from environment variable
    const correctPin = process.env.four_pin || process.env.FOUR_PIN;
    
    if (!correctPin) {
      console.error('four_pin environment variable not set');
      return res.status(500).json({
        success: false,
        error: 'PIN verification not configured'
      });
    }
    
    // Verify PIN
    if (pin === correctPin) {
      res.status(200).json({
        success: true,
        message: 'PIN verified successfully'
      });
    } else {
      res.status(401).json({
        success: false,
        error: 'Invalid PIN'
      });
    }
    
  } catch (error) {
    console.error('Error in /api/verify-pin:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Claim creator fees from a single pool
// Health check endpoint for RPC connectivity
app.get('/api/health/rpc', async (req, res) => {
  try {
    const { Connection } = require('@solana/web3.js');
    const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "726140d8-6b0d-4719-8702-682d81e94a37";
    const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
    const FALLBACK_RPC = "https://api.mainnet-beta.solana.com";
    
    const results = {};
    
    // Test Helius RPC
    try {
      const heliusConnection = new Connection(RPC_URL, 'confirmed');
      const heliusStart = Date.now();
      const heliusBlockhash = await heliusConnection.getLatestBlockhash('confirmed');
      results.helius = {
        status: 'healthy',
        latency: Date.now() - heliusStart,
        blockhash: heliusBlockhash.blockhash.substring(0, 8) + '...'
      };
    } catch (error) {
      results.helius = {
        status: 'unhealthy',
        error: error.message
      };
    }
    
    // Test fallback RPC
    try {
      const fallbackConnection = new Connection(FALLBACK_RPC, 'confirmed');
      const fallbackStart = Date.now();
      const fallbackBlockhash = await fallbackConnection.getLatestBlockhash('confirmed');
      results.fallback = {
        status: 'healthy',
        latency: Date.now() - fallbackStart,
        blockhash: fallbackBlockhash.blockhash.substring(0, 8) + '...'
      };
    } catch (error) {
      results.fallback = {
        status: 'unhealthy',
        error: error.message
      };
    }
    
    const allHealthy = results.helius.status === 'healthy' || results.fallback.status === 'healthy';
    
    res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      rpcEndpoints: results
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

app.post('/api/claim-creator-fees', async (req, res) => {
  try {
    console.log('====== CLAIM CREATOR FEES ENDPOINT ======');
    const { poolAddress, userId, creatorPrivateKey, signedTxBase64 } = req.body;
    if (!poolAddress || !userId) {
      return res.status(400).json({ success: false, error: 'Pool address and user ID are required' });
    }

    // Initialize Supabase (for DB lookup and logging)
    const { createClient } = require('@supabase/supabase-js');
    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

    // Broadcast mode (client provided a signed tx)
    if (signedTxBase64) {
      let connection;
      try {
        connection = await getHeliusConnectionOrThrow();
      } catch (e) {
        return res.status(502).json({ success: false, error: e.message || 'Helius RPC unavailable' });
      }
      const broadcast = await broadcastSignedClaimTx({ connection, supabaseClient: supabaseAdmin, poolAddress, userId, signedTxBase64 });
      return res.status(200).json({ success: true, transactionSignature: broadcast.signature, solscanUrl: `https://solscan.io/tx/${broadcast.signature}` });
    }

    // Legacy mode (temporary support) if private key provided
    if (creatorPrivateKey) {
      const legacy = await claimCreatorFees(poolAddress, creatorPrivateKey, userId);
      const code = legacy.success ? 200 : 500;
      return res.status(code).json(legacy);
    }

    // Prepare mode: build unsigned tx for user to sign with Privy
    // Lookup user's Privy wallet address from DB
    const { data: userRow, error: userErr } = await supabaseAdmin
      .from('users')
      .select('wallet_address')
      .eq('id', userId)
      .single();
    if (userErr || !userRow?.wallet_address) {
      return res.status(400).json({ success: false, error: 'User wallet not found' });
    }

    let connection;
    try {
      connection = await getHeliusConnectionOrThrow();
    } catch (e) {
      return res.status(502).json({ success: false, error: e.message || 'Helius RPC unavailable' });
    }
    const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
    const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');

    const { PublicKey } = require('@solana/web3.js');
    const poolPubkey = new PublicKey(poolAddress);
    const userWalletPubkey = new PublicKey(userRow.wallet_address);

    // Check fee metrics and migration
    let feeMetrics;
    try {
      feeMetrics = await dbcClient.state.getPoolFeeMetrics(poolPubkey);
    } catch (e) {
      feeMetrics = null;
    }

    if (feeMetrics && feeMetrics.current && (!feeMetrics.current.creatorBaseFee.isZero() || !feeMetrics.current.creatorQuoteFee.isZero())) {
      const tx = await prepareCreatorClaimTxDBC({ connection, dbcClient, poolPubkey, userWalletPubkey, feeMetrics });
      const txBase64 = tx.serialize({ requireAllSignatures: false }).toString('base64');
      return res.status(200).json({ success: true, needsSignature: true, transactions: [txBase64] });
    }

    // If no fees on DBC, check migration to DAMM v2
    const migration = await checkPoolMigrationOfficial(poolAddress, connection);
    if (migration.migrated && migration.dammVersion === 'v2') {
      const migratedPoolAddress = await getMigratedPoolAddress(poolAddress, connection, 'v2');
      const txs = await prepareCreatorClaimTxDammV2({ connection, migratedPoolAddress: migratedPoolAddress.toString(), userWalletPubkey });
      if (txs.length === 0) {
        return res.status(400).json({ success: false, error: 'No positions found to claim' });
      }
      const base64s = txs.map(tx => tx.serialize({ requireAllSignatures: false }).toString('base64'));
      return res.status(200).json({ success: true, needsSignature: true, transactions: base64s, migrated: true, dammVersion: 'v2', newPoolAddress: migratedPoolAddress.toString() });
    }

    return res.status(400).json({ success: false, error: 'No creator fees available to claim' });
  } catch (error) {
    console.error('====== ERROR IN CREATOR CLAIM ENDPOINT ======');
    console.error('Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

// Claim all creator fees for a user
app.post('/api/claim-all-creator-fees', async (req, res) => {
  try {
    console.log('====== CLAIM ALL CREATOR FEES ENDPOINT ======');
    
    const { userId, creatorPrivateKey } = req.body;
    
    if (!userId || !creatorPrivateKey) {
      return res.status(400).json({
        success: false,
        error: 'User ID and creator private key are required'
      });
    }
    
    console.log('Starting claim all process for user:', userId);
    const result = await claimAllCreatorFees(userId, creatorPrivateKey);
    
    console.log('Claim all result:', result.success ? 'SUCCESS' : 'FAILED');
    
    if (result.success || result.poolsProcessed > 0) {
      res.status(200).json(result);
    } else {
      res.status(500).json(result);
    }
    
  } catch (error) {
    console.error('====== ERROR IN CLAIM ALL ENDPOINT ======');
    console.error('Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Check available creator fees for a pool
app.get('/api/creator-fees/:poolAddress', async (req, res) => {
  try {
    const { poolAddress } = req.params;
    
    if (!poolAddress) {
      return res.status(400).json({
        success: false,
        error: 'Pool address is required'
      });
    }
    
    const result = await checkAvailableCreatorFees(poolAddress);
    res.status(200).json(result);
    
  } catch (error) {
    console.error('Error in /api/creator-fees:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Admin: one-off claim with ADMIN_PRIVATE_KEY for a single pool
app.post('/api/admin/claim-creator-fees-once', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${process.env.ADMIN_AUTH_TOKEN || 'admin-secret'}`) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { poolAddress, token_mint, config_address, user_id, claim_wallet } = req.body || {};
    if (!poolAddress) {
      return res.status(400).json({ success: false, error: 'poolAddress is required' });
    }
    // Optional: lock to known address
    const ALLOWED_POOL = 'G91itYzrXSenm1LqA4XS292reHmZPDDekRTJBMYMb9LV';
    if (poolAddress !== ALLOWED_POOL) {
      return res.status(403).json({ success: false, error: 'Pool not allowed for this one-off endpoint' });
    }
    const adminKey = process.env.dev_private_key;
    if (!adminKey) {
      return res.status(500).json({ success: false, error: 'dev_private_key not configured' });
    }
    // Pass through the provided user_id to align DB updates with the creator's records
    const result = await claimCreatorFees(poolAddress, adminKey, user_id || 'admin');
    // Note: token_mint, config_address, and claim_wallet are accepted for parity with UI payloads
    // but the underlying claim function derives necessary accounts from on-chain state.
    const code = result.success ? 200 : 500;
    return res.status(code).json(result);
  } catch (err) {
    console.error('Admin one-off claim error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal error' });
  }
});

// Giveaway: broadcast launch then send 0.01 SOL to creator from GIVEAWAY_WALLET
app.post('/api/giveaway/launch-token/broadcast', async (req, res) => {
  try {
    const { signedTxBase64, userId, mintAddress, poolAddress, metadataName, metadataSymbol, metadataUri, usedKeypairId } = req.body || {};
    if (!signedTxBase64 || !userId || !poolAddress) {
      return res.status(400).json({ success: false, error: 'signedTxBase64, userId, and poolAddress are required' });
    }
    let connection;
    try {
      connection = await getHeliusConnectionOrThrow();
    } catch (e) {
      return res.status(502).json({ success: false, error: e.message || 'Helius RPC unavailable' });
    }
    // 1) Broadcast the launch transaction using existing helper
    const launch = await broadcastSignedTransaction({ signedTxBase64, userId, mintAddress, poolAddress, metadataName, metadataSymbol, metadataUri, usedKeypairId });
    if (!launch?.success && !launch?.transactionSignature) {
      return res.status(500).json({ success: false, error: launch?.error || 'Broadcast failed' });
    }
    // 2) Fetch recipient (creator Privy wallet)
    const supabaseAdmin = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: urow } = await supabaseAdmin
      .from('users')
      .select('wallet_address')
      .eq('id', userId)
      .single();
    const recipient = urow?.wallet_address;
    let bonus = { success: false };
    // 3) Send bonus if recipient present and funded wallet configured
    const giveawayKeyRaw = process.env.GIVEAWAY_WALLET;
    if (recipient && giveawayKeyRaw) {
      try {
        const giver = parsePrivateKey(giveawayKeyRaw);
        const tx = new Transaction().add(SystemProgram.transfer({
          fromPubkey: giver.publicKey,
          toPubkey: new PublicKey(recipient),
          lamports: Math.floor(0.01 * LAMPORTS_PER_SOL),
        }));
        tx.feePayer = giver.publicKey;
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.sign(giver);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
        await connection.confirmTransaction(sig, 'confirmed');
        bonus = { success: true, bonusSignature: sig };
      } catch (e) {
        bonus = { success: false, error: e.message || String(e) };
      }
    }
    return res.status(200).json({
      success: true,
      transactionSignature: launch.transactionSignature,
      solscanUrl: launch.solscanUrl,
      bonusTransfer: bonus,
    });
  } catch (error) {
    console.error('Giveaway broadcast error:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal error' });
  }
});

// Webhook endpoint removed - using DBC SDK polling instead

// Setup webhook for a pool
app.post('/api/webhooks/setup', async (req, res) => {
  try {
    console.log('Setting up webhook for pool...');
    
    const { poolAddress, postId } = req.body;
    
    if (!poolAddress) {
      return res.status(400).json({
        success: false,
        error: 'Pool address is required'
      });
    }
    
    const result = await setupPoolWebhook(poolAddress, postId);
    
    res.status(200).json({
      success: true,
      webhookId: result.webhookID,
      poolAddress
    });
    
  } catch (error) {
    console.error('Error setting up webhook:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to setup webhook'
    });
  }
});

// List all active webhooks
app.get('/api/webhooks/list', async (req, res) => {
  try {
    // Verify admin auth
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${process.env.ADMIN_AUTH_TOKEN || 'admin-secret'}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const webhooks = await listWebhooks();
    res.status(200).json({ success: true, webhooks });
    
  } catch (error) {
    console.error('Error listing webhooks:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to list webhooks'
    });
  }
});

// Test endpoint for checking pool migration status
app.get('/api/pool-migration-status/:poolAddress', async (req, res) => {
  try {
    const { poolAddress } = req.params;
    const { checkPoolMigration } = require('./checkPoolMigration');
    
    console.log('Checking migration status for pool:', poolAddress);
    const migrationStatus = await checkPoolMigration(poolAddress);
    
    res.status(200).json({
      success: true,
      ...migrationStatus
    });
    
  } catch (error) {
    console.error('Error checking migration status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check migration status'
    });
  }
});

// Sync all-time fees for all pools
app.post('/api/fees/sync-all', async (req, res) => {
  try {
    console.log('====== SYNCING ALL-TIME FEES ======');
    
    await syncAllTimeFees();
    
    res.status(200).json({
      success: true,
      message: 'Fee sync completed'
    });
    
  } catch (error) {
    console.error('Error syncing fees:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to sync fees'
    });
  }
});

// Get lifetime fees for specific pool using DBC SDK
app.get('/api/fees/lifetime/:poolAddress', async (req, res) => {
  try {
    const { poolAddress } = req.params;
    
    console.log(`Getting lifetime fees for pool: ${poolAddress}`);
    
    const result = await getLifetimeFees(poolAddress);
    
    res.status(200).json(result);
    
  } catch (error) {
    console.error('Error getting lifetime fees:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get fees'
    });
  }
});

// Update post endpoint removed - updates happen in getLifetimeFees.js instead

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: 'Something went wrong!'
  });
});

// Test keypair worker endpoint
app.get('/api/test-keypair-worker', async (req, res) => {
  console.log('\n🔧 TEST KEYPAIR WORKER ENDPOINT CALLED');
  
  try {
    // Test Supabase connection
    console.log('Testing Supabase connection...');
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );
    
    // Try to count keypairs
    const { count, error: countError } = await supabase
      .from('keypairs')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('❌ Supabase count error:', countError);
      return res.status(500).json({
        success: false,
        error: 'Database connection failed',
        details: countError
      });
    }
    
    console.log(`✅ Database connected! Current keypair count: ${count}`);
    
    // Try to generate and insert one keypair
    console.log('Generating test keypair...');
    const { Keypair } = require('@solana/web3.js');
    const bs58 = require('bs58').default;
    
    const keypair = Keypair.generate();
    const testKeypair = {
      public_key: keypair.publicKey.toBase58(),
      secret_key: bs58.encode(keypair.secretKey),
      has_vanity_suffix: false,
      vanity_suffix: null
    };
    
    console.log('Inserting test keypair:', testKeypair.public_key);
    
    const { data, error } = await supabase
      .from('keypairs')
      .insert([testKeypair])
      .select();
    
    if (error) {
      console.error('❌ Insert error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to insert keypair',
        details: error
      });
    }
    
    console.log('✅ Test keypair inserted successfully!');
    
    res.json({
      success: true,
      message: 'Keypair worker test successful',
      currentCount: count,
      testKeypair: testKeypair.public_key,
      inserted: data
    });
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Daily Bugle Token Launch Endpoint
app.post('/api/daily-bugle-launch', async (req, res) => {
  try {
    console.log('=== DAILY BUGLE LAUNCH ===');
    console.log('Request from:', req.headers.origin || 'Unknown origin');
    console.log('Authorization:', req.headers.authorization ? 'Present' : 'Missing');
    
    // Check for auth token
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.DAILY_BUGLE_AUTH_TOKEN || 'bugle-secret-2024';
    
    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
      console.error('Unauthorized Daily Bugle launch attempt');
      return res.status(401).json({
        success: false,
        error: 'Unauthorized. Daily Bugle auth token required.'
      });
    }
    
    // Import and execute the Daily Bugle launcher
    const { launchDailyBugleToken } = require('./dailyBugleLaunch');
    
    console.log('Launching Daily Bugle token...');
    const result = await launchDailyBugleToken();
    
    if (result.success) {
      console.log('✅ Daily Bugle token launched successfully!');
      res.status(200).json(result);
    } else {
      console.error('❌ Daily Bugle launch failed:', result.error);
      res.status(500).json(result);
    }
    
  } catch (error) {
    console.error('Error in /api/daily-bugle-launch:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Inkwell backend server running on port ${PORT}`);
  console.log(`Config address: ${process.env.DBC_CONFIG_PUBKEY}`);
  console.log(`RPC endpoint: https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY?.substring(0, 8)}...`);
  
  // DISABLED: Periodic fee sync - now using manual refresh only
  // console.log('Starting periodic lifetime fee sync job...');
  // setInterval(async () => {
  //   console.log('[CRON] Running lifetime fee sync...');
  //   try {
  //     await updateAllPoolsLifetimeFees();
  //     console.log('[CRON] Lifetime fee sync completed');
  //   } catch (error) {
  //     console.error('[CRON] Lifetime fee sync error:', error);
  //   }
  // }, 5 * 60 * 1000); // 5 minutes
  
  // // Run initial sync after 10 seconds
  // setTimeout(async () => {
  //   console.log('[STARTUP] Running initial lifetime fee sync...');
  //   try {
  //     await updateAllPoolsLifetimeFees();
  //     console.log('[STARTUP] Initial lifetime fee sync completed');
  //   } catch (error) {
  //     console.error('[STARTUP] Initial lifetime fee sync error:', error);
  //   }
  // }, 10000);

// Profile Token Launch Endpoint
const { launchProfileToken } = require('./profileTokenLauncher');

// GET variant to support Server-Sent Events (SSE) progress without breaking POST JSON callers.
app.get('/api/launch-profile-token', async (req, res) => {
  try {
    const userId = (req.query.userId || '').toString();
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    if (!process.env.PROFILE_TOKEN_WALLET_PRIVATE_KEY) {
      return res.status(500).json({ success: false, error: 'Profile token system not configured' });
    }

    const wantsSSE = req.query.sse === '1' || /text\/event-stream/.test(String(req.headers.accept || ''));
    if (!wantsSSE) {
      return res.status(400).json({ success: false, error: 'For GET, use ?sse=1 and Accept: text/event-stream' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.flushHeaders && res.flushHeaders();

    const send = (event, dataObj) => {
      const data = JSON.stringify(dataObj);
      res.write(`event: ${event}\n`);
      res.write(`data: ${data}\n\n`);
    };

    send('overlay', { state: 'open', message: 'Launching your profile token!' });
    try {
      const result = await launchProfileToken(userId);
      if (result.success) {
        send('overlay', { state: 'close', success: true, result });
      } else {
        send('overlay', { state: 'close', success: false, error: result.error });
      }
    } catch (err) {
      send('overlay', { state: 'close', success: false, error: err?.message || 'Internal error' });
    }
    res.end();
  } catch (error) {
    console.error('Error in GET /api/launch-profile-token:', error);
    try {
      res.end();
    } catch {}
  }
});

app.post('/api/launch-profile-token', async (req, res) => {
  try {
    console.log('=== PROFILE TOKEN LAUNCH ===');
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }
    
    console.log(`Launching profile token for user: ${userId}`);
    
    // Check if profile token wallet is configured
    if (!process.env.PROFILE_TOKEN_WALLET_PRIVATE_KEY) {
      console.error('PROFILE_TOKEN_WALLET_PRIVATE_KEY not configured');
      return res.status(500).json({
        success: false,
        error: 'Profile token system not configured'
      });
    }
    
    // Optional SSE mode for UI progress signals without changing callers by default.
    // Enable by sending Accept: text/event-stream or query ?sse=1
    const wantsSSE = req.query.sse === '1' || /text\/event-stream/.test(String(req.headers.accept || ''));
    if (wantsSSE) {
      // Set up Server-Sent Events stream
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      // CORS echo
      if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.flushHeaders && res.flushHeaders();

      const send = (event, dataObj) => {
        const data = JSON.stringify(dataObj);
        res.write(`event: ${event}\n`);
        res.write(`data: ${data}\n\n`);
      };

      // Notify client overlay to open
      send('overlay', { state: 'open', message: 'Launching your profile token!' });

      try {
        const result = await launchProfileToken(userId);
        if (result.success) {
          console.log('Profile token launched successfully');
          // Notify success and ask client to close overlay
          send('overlay', { state: 'close', success: true, result });
          res.end();
        } else {
          console.error('Profile token launch failed:', result.error);
          send('overlay', { state: 'close', success: false, error: result.error });
          res.end();
        }
      } catch (err) {
        console.error('SSE flow error in /api/launch-profile-token:', err);
        send('overlay', { state: 'close', success: false, error: err?.message || 'Internal error' });
        res.end();
      }
      return; // Do not continue to JSON flow
    }

    // Default JSON flow
    const result = await launchProfileToken(userId);

    if (result.success) {
      console.log('Profile token launched successfully');
      res.status(200).json(result);
    } else {
      console.error('Profile token launch failed:', result.error);
      res.status(400).json(result);
    }
    
  } catch (error) {
    console.error('Error in /api/launch-profile-token:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

});

module.exports = app;
// Force redeploy Mon Sep 15 14:11:21 PDT 2025
