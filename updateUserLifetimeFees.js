// Update user's lifetime fees by summing all their posts' fees
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
) : null;

// Update lifetime fees for a specific user
async function updateUserLifetimeFees(userId) {
  if (!supabase) {
    console.error('Supabase not initialized');
    return { success: false, error: 'Supabase not initialized' };
  }

  try {
    console.log(`\n📊 Updating lifetime fees for user ${userId}`);
    
    // Get all posts for this user and sum their total fees
    const { data: posts, error: postsError } = await supabase
      .from('user_posts')
      .select('total_fees_generated_all_time')
      .eq('user_id', userId);
      
    if (postsError) {
      console.error('Error fetching user posts:', postsError);
      return { success: false, error: postsError.message };
    }
    
    // Calculate total lifetime fees
    let totalLifetimeFees = 0;
    if (posts && posts.length > 0) {
      totalLifetimeFees = posts.reduce((sum, post) => {
        const fees = parseFloat(post.total_fees_generated_all_time || '0');
        return sum + fees;
      }, 0);
    }
    
    console.log(`- Found ${posts?.length || 0} posts`);
    console.log(`- Total lifetime fees: ${totalLifetimeFees} SOL`);
    
    // Update user's lifetime fees
    const { data, error } = await supabase
      .from('users')
      .update({
        lifetime_fees_generated: totalLifetimeFees
      })
      .eq('id', userId)
      .select();
      
    if (error) {
      console.error('Error updating user lifetime fees:', error);
      return { success: false, error: error.message };
    }
    
    console.log('✅ User lifetime fees updated successfully');
    if (data && data.length > 0) {
      console.log(`- New total: ${data[0].lifetime_fees_generated} SOL`);
    }
    
    return {
      success: true,
      lifetimeFees: totalLifetimeFees,
      userId
    };
    
  } catch (error) {
    console.error('Error in updateUserLifetimeFees:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Update all users' lifetime fees
async function updateAllUsersLifetimeFees() {
  if (!supabase) {
    console.error('Supabase not initialized');
    return;
  }

  try {
    console.log('\n🔄 Updating lifetime fees for all users...');
    
    // Get all unique user IDs who have posts
    const { data: userIds, error } = await supabase
      .from('user_posts')
      .select('user_id')
      .not('user_id', 'is', null);
      
    if (error) {
      console.error('Error fetching user IDs:', error);
      return;
    }
    
    // Get unique user IDs
    const uniqueUserIds = [...new Set(userIds.map(row => row.user_id))];
    console.log(`Found ${uniqueUserIds.length} users with posts`);
    
    // Update each user
    for (const userId of uniqueUserIds) {
      await updateUserLifetimeFees(userId);
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log('✅ All users updated successfully');
    
  } catch (error) {
    console.error('Error updating all users:', error);
  }
}

module.exports = {
  updateUserLifetimeFees,
  updateAllUsersLifetimeFees
};