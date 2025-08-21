require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false } }
);

(async () => {
  // Check post-media bucket
  const { data, error } = await supabase.storage
    .from('post-media')
    .list('posts', { limit: 5 });
  
  if (error) {
    console.log('Error accessing post-media:', error.message);
  } else {
    console.log('✅ post-media bucket works! Files found:', data?.length || 0);
    if (data && data.length > 0) {
      console.log('Sample files:', data.slice(0, 3).map(f => f.name));
    }
  }
})();