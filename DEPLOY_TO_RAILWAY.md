# 🚀 DEPLOY TO RAILWAY IN 2 MINUTES

## Step 1: Push Backend to GitHub

First, commit and push the backend folder:

```bash
git add backend/
git commit -m "Add backend for token launching"
git push
```

## Step 2: Deploy to Railway

### Option A: Deploy via GitHub (AUTO-DEPLOY ENABLED)

1. Go to [railway.app](https://railway.app)
2. Click **"Start a New Project"**
3. Choose **"Deploy from GitHub repo"**
4. Authorize Railway to access your GitHub
5. Select your repo: `inkwell-feed`
6. Railway will auto-detect the backend

### Option B: Deploy via CLI

```bash
# Install Railway CLI (one time)
npm install -g @railway/cli

# Deploy
cd backend
railway login
railway init
railway up
```

## Step 3: Configure Environment Variables

In Railway dashboard:

1. Click on your deployed service
2. Go to **"Variables"** tab
3. Click **"RAW Editor"**
4. Paste this (with your actual values):

```env
ADMIN_PRIVATE_KEY=4GA38pEXfmyVR8gTjZiGbDV2TvaqKV8pWVa5m8gQYYamaxY9SdZoTM7adr2C9B3QCzULPJ9qkFG5XWNjp5hsa8Rm
HELIUS_API_KEY=148399dc-189f-4b46-84b6-a741677283b9
SUPABASE_URL=https://hfuqgtkurdgdctnrhnmw.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhmdXFndGt1cmRnZGN0bnJobm13Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzQyNTA0NzEsImV4cCI6MjA0OTgyNjQ3MX0.BnU-tmhFQeKz_4S1Mu9RuSd0Qpz6tMjkhgo2RfWONXo
DBC_CONFIG_PUBKEY=D21YtyrW79hiGuVrNGNeiuDsZpNyVqM9QJhiHEvsPcE4
```

5. Click **"Update Variables"**
6. Service will auto-restart

## Step 4: Get Your Backend URL

1. In Railway dashboard, click on your service
2. Go to **"Settings"** tab
3. Under **"Domains"**, click **"Generate Domain"**
4. You'll get a URL like: `inkwell-backend-production.up.railway.app`

## Step 5: Update Frontend to Use Backend

In your frontend code, create `.env.local`:

```env
VITE_BACKEND_URL=https://your-backend-url.up.railway.app
```

Or update `src/lib/tokenLauncherBackend.ts`:
```typescript
const BACKEND_URL = 'https://your-backend-url.up.railway.app';
```

## 🎉 DONE! AUTO-DEPLOY IS ENABLED

Now every time you push to GitHub:
- Railway automatically detects changes in `/backend`
- Rebuilds and redeploys automatically
- Zero downtime deployments

## Test Your Deployment

```bash
# Test health endpoint
curl https://your-backend-url.up.railway.app/health

# Should return:
# {"status":"ok","message":"Inkwell backend is running"}
```

## Monitoring

- View logs: Railway Dashboard → Your Service → "Logs" tab
- View metrics: Railway Dashboard → Your Service → "Metrics" tab
- Set up alerts: Railway Dashboard → Your Service → "Settings" → "Notifications"

## Troubleshooting

If deployment fails:
1. Check logs in Railway dashboard
2. Ensure all environment variables are set
3. Make sure `package.json` has `"start": "node server.js"`
4. Verify Node version: `"engines": { "node": ">=18.0.0" }`

## Cost

- Railway gives you $5 free credits/month
- This backend will use ~$2-3/month
- Auto-sleeps when not in use to save credits