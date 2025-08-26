const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { verifyPrivyAuth } = require('../middleware/privyAuth');
const jwt = require('jsonwebtoken');

// Define safe user fields for frontend consumption
const SAFE_USER_FIELDS = 'id, screen_name, profile_picture_url, banner_url, bio, auth_provider, created_at';

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Create or update user from Privy authentication
// This endpoint doesn't use middleware because it handles user creation
router.post('/privy-auth', async (req, res) => {
  try {
    // Manually verify the token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.decode(token);
    
    if (!decoded || !decoded.sub) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const privyUserId = decoded.sub;
    
    const { 
      walletAddress, 
      oauthIdentifier, 
      email, 
      screenName, 
      profilePictureUrl 
    } = req.body;
    
    // Check if user already exists
    let existingUser = null;
    
    // Try to find by Privy ID first
    const { data: userByPrivyId } = await supabase
      .from('users')
      .select(SAFE_USER_FIELDS)
      .eq('privy_user_id', privyUserId)
      .maybeSingle();
    
    if (userByPrivyId) {
      existingUser = userByPrivyId;
    } else {
      // Try other identifiers
      if (walletAddress) {
        const { data } = await supabase
          .from('users')
          .select(SAFE_USER_FIELDS)
          .eq('wallet_address', walletAddress)
          .maybeSingle();
        existingUser = data;
      }
      
      if (!existingUser && oauthIdentifier) {
        const { data } = await supabase
          .from('users')
          .select(SAFE_USER_FIELDS)
          .eq('oauth_identifier', oauthIdentifier)
          .maybeSingle();
        existingUser = data;
      }
      
      if (!existingUser && email) {
        const { data } = await supabase
          .from('users')
          .select(SAFE_USER_FIELDS)
          .eq('email', email)
          .maybeSingle();
        existingUser = data;
      }
    }
    
    let user;
    
    if (existingUser) {
      // Update existing user
      const updateData = {
        privy_user_id: privyUserId,
        ...(walletAddress && { wallet_address: walletAddress }),
        ...(oauthIdentifier && { oauth_identifier: oauthIdentifier }),
        ...(email && { email }),
        ...(screenName && { screen_name: screenName }),
        ...(profilePictureUrl && { profile_picture_url: profilePictureUrl }),
      };
      
      const { data, error } = await supabase
        .from('users')
        .update(updateData)
        .eq('id', existingUser.id)
        .select()
        .single();
      
      if (error) throw error;
      user = data;
    } else {
      // Create new user
      const { data, error } = await supabase
        .from('users')
        .insert({
          privy_user_id: privyUserId,
          wallet_address: walletAddress,
          oauth_identifier: oauthIdentifier,
          email,
          screen_name: screenName,
          profile_picture_url: profilePictureUrl,
          auth_provider: walletAddress ? 'wallet' : oauthIdentifier ? 'oauth' : 'email'
        })
        .select()
        .single();
      
      if (error) throw error;
      user = data;
      
      // Generate dev wallet for new user
      if (user) {
        try {
          const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/generate-dev-wallet`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ userId: user.id })
          });
          
          if (!response.ok) {
            console.error('Failed to generate dev wallet:', await response.text());
          }
        } catch (walletError) {
          console.error('Error generating dev wallet:', walletError);
          // Continue even if wallet generation fails
        }
      }
    }
    
    res.json({ 
      success: true, 
      user,
      isNewUser: !existingUser 
    });
    
  } catch (error) {
    console.error('Privy auth error:', error);
    res.status(500).json({ 
      error: 'Failed to authenticate user',
      details: error.message 
    });
  }
});

// Get current user
router.get('/me', verifyPrivyAuth, async (req, res) => {
  try {
    res.json({ 
      success: true, 
      user: req.user 
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ 
      error: 'Failed to get user',
      details: error.message 
    });
  }
});

// Update user profile
router.put('/profile', verifyPrivyAuth, async (req, res) => {
  try {
    const { screenName, bio, profilePictureUrl, bannerUrl } = req.body;
    const userId = req.user.id;
    
    const updateData = {};
    if (screenName !== undefined) updateData.screen_name = screenName;
    if (bio !== undefined) updateData.bio = bio;
    if (profilePictureUrl !== undefined) updateData.profile_picture_url = profilePictureUrl;
    if (bannerUrl !== undefined) updateData.banner_url = bannerUrl;
    
    const { data, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ 
      success: true, 
      user: data 
    });
    
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ 
      error: 'Failed to update profile',
      details: error.message 
    });
  }
});

module.exports = router;