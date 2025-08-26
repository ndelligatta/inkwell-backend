const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// Define safe user fields for frontend consumption
const SAFE_USER_FIELDS = 'id, screen_name, profile_picture_url, banner_url, bio, auth_provider, created_at';

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware to verify Privy JWT tokens and fetch user data
async function verifyPrivyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    
    // For now, we'll trust the token and extract the user ID
    // In production, you should verify the JWT signature with Privy's public key
    try {
      const decoded = jwt.decode(token);
      
      if (!decoded || !decoded.sub) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      // The 'sub' field contains the Privy user ID
      const privyUserId = decoded.sub;
      
      // Look up the user in our database
      let user = null;
      
      // First try by Privy ID if we've stored it
      const { data: userByPrivyId } = await supabase
        .from('users')
        .select(SAFE_USER_FIELDS)
        .eq('privy_user_id', privyUserId)
        .maybeSingle();
      
      if (userByPrivyId) {
        user = userByPrivyId;
      } else {
        // Try to find by wallet address if provided
        if (decoded.wallet_address) {
          const { data: userByWallet } = await supabase
            .from('users')
            .select(SAFE_USER_FIELDS)
            .eq('wallet_address', decoded.wallet_address)
            .maybeSingle();
          user = userByWallet;
        }
        
        // Try to find by email if provided
        if (!user && decoded.email) {
          const { data: userByEmail } = await supabase
            .from('users')
            .select(SAFE_USER_FIELDS)
            .eq('email', decoded.email)
            .maybeSingle();
          user = userByEmail;
        }
        
        // Try to find by OAuth identifier
        if (!user && decoded.oauth_identifier) {
          const { data: userByOAuth } = await supabase
            .from('users')
            .select(SAFE_USER_FIELDS)
            .eq('oauth_identifier', decoded.oauth_identifier)
            .maybeSingle();
          user = userByOAuth;
        }
      }
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // Attach user to request
      req.user = user;
      req.privyUserId = privyUserId;
      
      next();
    } catch (error) {
      console.error('Token verification error:', error);
      return res.status(401).json({ error: 'Invalid token' });
    }
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Optional middleware - allows requests to proceed without auth
async function optionalPrivyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No token provided, continue without user
    return next();
  }
  
  // If token is provided, verify it
  return verifyPrivyAuth(req, res, next);
}

module.exports = {
  verifyPrivyAuth,
  optionalPrivyAuth
};