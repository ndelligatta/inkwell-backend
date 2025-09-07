# Inkwell Backend - Token Launch API

Last updated: January 21, 2025
<!-- Force rebuild: 2025-09-07 -->

This is a Node.js/Express backend that handles token launching using Meteora's Dynamic Bonding Curve SDK. It's designed to replace the Supabase Edge Functions which had compatibility issues with the Solana SDKs.

## Setup

1. Install dependencies:
```bash
cd backend
npm install
```

2. Configure environment variables:
   - Copy `.env.example` to `.env` (or use the existing `.env`)
   - Ensure all required variables are set

3. Run the server:
```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm start
```

The server will run on port 3001 by default (configurable via PORT env variable).

## API Endpoints

### `POST /api/launch-token`
Launch a new token with the Dynamic Bonding Curve.

**Request Body:**
```json
{
  "name": "Token Name",
  "symbol": "TKN",
  "description": "Token description",
  "website": "https://example.com",
  "twitter": "https://twitter.com/example",
  "initialBuyAmount": 0.01,
  "userId": "user-uuid",
  "userPrivateKey": "base64-encoded-private-key",
  "imageBase64": "base64-image-data",
  "imageType": "image/png"
}
```

Or use FormData with `image` file field for file upload.

**Response:**
```json
{
  "success": true,
  "mintAddress": "TokenMintAddress...",
  "poolAddress": "PoolAddress...",
  "transactionSignature": "TxSignature...",
  "solscanUrl": "https://solscan.io/tx/..."
}
```

### `GET /api/dev-wallet/:userId`
Get user's dev wallet public key.

### `GET /health`
Health check endpoint.

## Frontend Integration

Update your frontend code to use the backend:

```typescript
// In CreatePostDialog.tsx or wherever you launch tokens
import { launchTokenViaBackend } from '@/lib/tokenLauncherBackend';

// Replace the direct SDK call with:
const result = await launchTokenViaBackend({
  name: tokenName,
  symbol: tokenSymbol,
  description: content,
  image: mediaFile,
  website: websiteUrl,
  twitter: twitterUrl,
  initialBuyAmount: 0.01
}, user.id, devPrivateKey);
```

## Environment Variables

- `ADMIN_PRIVATE_KEY`: Admin wallet private key
- `HELIUS_API_KEY`: Helius RPC API key
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_ANON_KEY`: Supabase anonymous key
- `DBC_CONFIG_PUBKEY`: DBC configuration public key (hardcoded to production config)
- `PORT`: Server port (default: 3001)

## Production Deployment

For production deployment, you can:

1. **Deploy on VPS/Cloud Server:**
   - Use PM2 for process management
   - Set up Nginx as reverse proxy
   - Enable SSL with Let's Encrypt

2. **Deploy on Railway/Render/Heroku:**
   - Push to GitHub
   - Connect to deployment platform
   - Set environment variables
   - Deploy

3. **Deploy on AWS/GCP/Azure:**
   - Use EC2/Compute Engine/VM
   - Or use container services (ECS/Cloud Run/Container Instances)

## Key Features

- ✅ Full compatibility with Meteora DBC SDK
- ✅ Handles image uploads to Supabase storage
- ✅ Creates Metaplex-standard metadata
- ✅ Tracks launches in database for fee claiming
- ✅ Supports initial token buys
- ✅ Hardcoded production config for consistent fees

## Security Notes

- Private keys are handled server-side only
- CORS is configured for cross-origin requests
- File uploads limited to 2MB
- Rate limiting should be added for production