// Profile Token Launcher - Separate from regular token launches
// This module handles the automatic creation of profile tokens for users

const { launchTokenDBC, parsePrivateKey } = require('./tokenLauncherImproved');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase environment variables');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  },
  db: {
    schema: 'public'
  },
  // Force schema refresh
  global: {
    headers: {
      'x-refresh-schema': 'true'
    }
  }
});

/**
 * Check if user already has a profile token
 */
async function userHasProfileToken(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('profile_token_mint')
      .eq('id', userId)
      .single();
    
    if (error) {
      console.error('Error checking profile token:', error);
      return false;
    }
    
    return !!data?.profile_token_mint;
  } catch (error) {
    console.error('Error in userHasProfileToken:', error);
    return false;
  }
}

/**
 * Get user data for profile token creation
 */
async function getUserDataForToken(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, wallet_address, screen_name, profile_picture_url')
      .eq('id', userId)
      .single();
    
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error fetching user data:', error);
    throw new Error('User not found');
  }
}

/**
 * Download image from URL and convert to buffer
 */
async function downloadImageAsBuffer(imageUrl) {
  try {
    if (!imageUrl) return null;
    
    // Handle Supabase storage URLs
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'BlockParty-ProfileToken/1.0'
      }
    });
    
    return Buffer.from(response.data);
  } catch (error) {
    console.error('Error downloading image:', error.message);
    return null;
  }
}

/**
 * Update user record with profile token information
 */
async function updateUserProfileToken(userId, tokenData) {
  try {
    const { error } = await supabase
      .from('users')
      .update({
        profile_token_mint: tokenData.mintAddress,
        profile_token_pool: tokenData.poolAddress,
        profile_token_launched_at: new Date().toISOString(),
        profile_token_tx_signature: tokenData.transactionSignature
        // user_token_MK: 4200.00 // Temporarily disabled until schema cache updates
      })
      .eq('id', userId);
    
    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Error updating user profile token:', error);
    throw error;
  }
}

/**
 * Launch profile token for a user
 */
async function launchProfileToken(userId) {
  try {
    // Check if user already has a profile token
    if (await userHasProfileToken(userId)) {
      return {
        success: false,
        error: 'User already has a profile token'
      };
    }
    
    // Get user data
    const user = await getUserDataForToken(userId);
    if (!user) {
      return {
        success: false,
        error: 'User not found'
      };
    }
    
    console.log(`Launching profile token for user: ${user.screen_name} (${userId})`);
    
    // Prepare metadata
    const metadata = {
      name: user.screen_name,
      symbol: 'PARTY',
      description: `Profile token for ${user.screen_name} on BlockParty. Join the party at https://blockparty.fun/profile/${user.wallet_address}`,
      website: `https://blockparty.fun/profile/${user.wallet_address}`,
      twitter: 'https://x.com/blockpartysol',
      initialBuyAmount: 0.01 // 0.01 SOL initial buy
    };
    
    // Handle profile picture
    if (user.profile_picture_url) {
      const imageBuffer = await downloadImageAsBuffer(user.profile_picture_url);
      if (imageBuffer) {
        metadata.image = imageBuffer;
        metadata.imageType = 'image/png'; // Default to PNG, actual type will be detected
      }
    }
    
    // Get profile token wallet from environment
    const profileTokenWallet = process.env.PROFILE_TOKEN_WALLET_PRIVATE_KEY;
    if (!profileTokenWallet) {
      console.error('PROFILE_TOKEN_WALLET_PRIVATE_KEY not set in environment');
      return {
        success: false,
        error: 'Profile token wallet not configured'
      };
    }
    
    // Launch token using existing infrastructure
    console.log('Calling launchTokenDBC with profile token metadata...');
    const result = await launchTokenDBC(metadata, userId, profileTokenWallet);
    
    if (result.success) {
      // Update user record with token info
      await updateUserProfileToken(userId, result);
      
      console.log(`Profile token launched successfully for ${user.screen_name}:`);
      console.log(`- Mint: ${result.mintAddress}`);
      console.log(`- Pool: ${result.poolAddress}`);
      console.log(`- TX: ${result.transactionSignature}`);
    }
    
    return result;
    
  } catch (error) {
    console.error('Error launching profile token:', error);
    return {
      success: false,
      error: error.message || 'Failed to launch profile token'
    };
  }
}

module.exports = {
  launchProfileToken,
  userHasProfileToken,
  getUserDataForToken
};