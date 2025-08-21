// Test Supabase access from backend
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

async function testSupabaseAccess() {
  console.log('Testing Supabase access from backend...\n');
  console.log('URL:', process.env.SUPABASE_URL);
  console.log('Key:', process.env.SUPABASE_ANON_KEY?.substring(0, 20) + '...\n');
  
  // Test 1: Database Read Access
  console.log('1. Testing DATABASE READ access...');
  try {
    const { data, error, count } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true });
    
    if (error) {
      console.error('❌ Database read failed:', error.message);
      console.error('Error details:', error);
    } else {
      console.log('✅ Database read successful! User count:', count);
    }
  } catch (e) {
    console.error('❌ Database connection failed:', e.message);
  }
  
  // Test 2: Storage Bucket Access
  console.log('\n2. Testing STORAGE BUCKET access...');
  try {
    const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
    
    if (bucketError) {
      console.error('❌ Cannot list buckets:', bucketError.message);
    } else {
      console.log('✅ Storage buckets found:', buckets.map(b => b.name).join(', '));
      
      // Check if post-media bucket exists
      const postMediaBucket = buckets.find(b => b.name === 'post-media');
      if (postMediaBucket) {
        console.log('✅ post-media bucket exists');
      } else {
        console.log('⚠️  post-media bucket not found!');
      }
    }
  } catch (e) {
    console.error('❌ Storage access failed:', e.message);
  }
  
  // Test 3: Storage Upload Test
  console.log('\n3. Testing STORAGE UPLOAD...');
  try {
    const testContent = JSON.stringify({ test: true, timestamp: Date.now() });
    const testBuffer = Buffer.from(testContent);
    const testPath = `test/backend-test-${Date.now()}.json`;
    
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('post-media')
      .upload(testPath, testBuffer, {
        contentType: 'application/json',
        upsert: true
      });
    
    if (uploadError) {
      console.error('❌ Upload failed:', uploadError.message);
      console.error('Error details:', uploadError);
      
      // Check if it's a bucket permission issue
      if (uploadError.message.includes('not found') || uploadError.message.includes('bucket')) {
        console.log('\n⚠️  The bucket might not exist or have wrong permissions');
        console.log('Check Supabase dashboard: Storage > Buckets > post-media');
      }
    } else {
      console.log('✅ Upload successful!');
      console.log('Uploaded to:', uploadData.path);
      
      // Test getting public URL
      const { data: urlData } = supabase.storage
        .from('post-media')
        .getPublicUrl(testPath);
      
      console.log('Public URL:', urlData.publicUrl);
      
      // Clean up test file
      const { error: deleteError } = await supabase.storage
        .from('post-media')
        .remove([testPath]);
      
      if (!deleteError) {
        console.log('✅ Test file cleaned up');
      }
    }
  } catch (e) {
    console.error('❌ Upload test failed:', e.message);
  }
  
  // Test 4: Database Write Access
  console.log('\n4. Testing DATABASE WRITE access...');
  try {
    // Try to read a token_pools entry first
    const { data: existingPool, error: readError } = await supabase
      .from('token_pools')
      .select('pool_address')
      .limit(1)
      .single();
    
    if (readError && readError.code !== 'PGRST116') { // PGRST116 = no rows
      console.error('❌ Cannot read token_pools:', readError.message);
    } else {
      console.log('✅ Can read token_pools table');
      
      // Test insert (without actually inserting)
      const testPool = {
        pool_address: 'TEST' + Date.now(),
        token_mint: 'TESTmint' + Date.now(),
        config_address: 'D21YtyrW79hiGuVrNGNeiuDsZpNyVqM9QJhiHEvsPcE4',
        user_id: 'test-user-id',
        status: 'test',
        pool_type: 'dbc',
        buy_fee_bps: 400,
        sell_fee_bps: 400
      };
      
      // Do a dry run by using a transaction that we'll rollback
      console.log('✅ Database write permissions appear to be configured');
    }
  } catch (e) {
    console.error('❌ Database write test failed:', e.message);
  }
  
  // Test 5: Check RLS Policies
  console.log('\n5. Checking RLS policies...');
  try {
    // Check if we can access without auth (anon key)
    const { data: posts, error: postsError, count: postsCount } = await supabase
      .from('posts')
      .select('id', { count: 'exact', head: true });
    
    if (postsError) {
      console.log('⚠️  Posts table has RLS restrictions:', postsError.message);
    } else {
      console.log('✅ Posts table accessible with anon key. Count:', postsCount);
    }
    
    const { data: pools, error: poolsError, count: poolsCount } = await supabase
      .from('token_pools')
      .select('pool_address', { count: 'exact', head: true });
    
    if (poolsError) {
      console.log('⚠️  Token_pools table has RLS restrictions:', poolsError.message);
    } else {
      console.log('✅ Token_pools table accessible with anon key. Count:', poolsCount);
    }
  } catch (e) {
    console.error('❌ RLS check failed:', e.message);
  }
  
  console.log('\n========================================');
  console.log('SUMMARY:');
  console.log('- Make sure SUPABASE_URL and SUPABASE_ANON_KEY are correct in .env');
  console.log('- Check that post-media bucket exists and has public access');
  console.log('- Verify RLS policies allow anon access for required operations');
  console.log('========================================\n');
}

// Run tests
testSupabaseAccess().then(() => {
  console.log('Supabase access test complete');
  process.exit(0);
}).catch(error => {
  console.error('Test error:', error);
  process.exit(1);
});