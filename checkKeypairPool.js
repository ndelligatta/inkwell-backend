// Script to check keypair pool status
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function checkPoolStatus() {
  try {
    console.log('=== KEYPAIR POOL STATUS ===');
    console.log(`Time: ${new Date().toISOString()}\n`);
    
    // Get total count
    const { count: totalCount, error: countError } = await supabase
      .from('keypairs')
      .select('*', { count: 'exact', head: true });
    
    if (countError) throw countError;
    
    // Get vanity count
    const { count: vanityCount, error: vanityError } = await supabase
      .from('keypairs')
      .select('*', { count: 'exact', head: true })
      .eq('has_vanity_suffix', true);
    
    if (vanityError) throw vanityError;
    
    // Get sample keypairs
    const { data: samples, error: sampleError } = await supabase
      .from('keypairs')
      .select('public_key, has_vanity_suffix, created_at')
      .order('created_at', { ascending: false })
      .limit(5);
    
    if (sampleError) throw sampleError;
    
    console.log(`Total keypairs: ${totalCount}`);
    console.log(`Vanity keypairs: ${vanityCount} (${totalCount > 0 ? ((vanityCount/totalCount)*100).toFixed(1) : 0}%)`);
    console.log(`Regular keypairs: ${totalCount - vanityCount}\n`);
    
    if (samples && samples.length > 0) {
      console.log('Latest keypairs:');
      samples.forEach(kp => {
        const age = Math.floor((Date.now() - new Date(kp.created_at).getTime()) / 1000);
        console.log(`- ${kp.public_key} ${kp.has_vanity_suffix ? '(VANITY)' : ''} - ${age}s ago`);
      });
    }
    
    // Check generation rate
    const { data: oldestKeypair, error: oldestError } = await supabase
      .from('keypairs')
      .select('created_at')
      .order('created_at', { ascending: true })
      .limit(1)
      .single();
    
    if (!oldestError && oldestKeypair && totalCount > 0) {
      const ageSeconds = (Date.now() - new Date(oldestKeypair.created_at).getTime()) / 1000;
      const rate = totalCount / ageSeconds;
      console.log(`\nGeneration rate: ${rate.toFixed(2)} keypairs/second`);
    }
    
  } catch (error) {
    console.error('Error checking pool status:', error);
  }
}

// Run the check
checkPoolStatus();