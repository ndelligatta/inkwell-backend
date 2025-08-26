// Scheduled fee updater - runs periodically instead of constantly
const { updateAllPoolsLifetimeFees } = require('./getLifetimeFees');
const { updateAllUsersLifetimeFees } = require('./updateUserLifetimeFees');

// Configuration
const UPDATE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const ENABLED = process.env.FEE_SCHEDULER_ENABLED === 'true';

console.log('Fee scheduler configuration:');
console.log('- Enabled:', ENABLED);
console.log('- Update interval:', UPDATE_INTERVAL_MS / 1000 / 60, 'minutes');

async function updateFees() {
  if (!ENABLED) {
    console.log('Fee scheduler is disabled');
    return;
  }

  console.log('=== Starting scheduled fee update ===');
  const startTime = Date.now();
  
  try {
    // Update pool fees
    console.log('Updating pool lifetime fees...');
    const poolsUpdated = await updateAllPoolsLifetimeFees();
    console.log(`Updated ${poolsUpdated} pools`);
    
    // Update user fees
    console.log('Updating user lifetime fees...');
    const usersUpdated = await updateAllUsersLifetimeFees();
    console.log(`Updated ${usersUpdated} users`);
    
    const duration = Date.now() - startTime;
    console.log(`=== Fee update completed in ${duration}ms ===`);
    
  } catch (error) {
    console.error('Error in scheduled fee update:', error);
  }
}

// Run once on startup if enabled
if (ENABLED) {
  console.log('Running initial fee update...');
  updateFees();
  
  // Schedule periodic updates
  setInterval(updateFees, UPDATE_INTERVAL_MS);
  console.log('Fee scheduler started successfully');
} else {
  console.log('Fee scheduler is disabled - set FEE_SCHEDULER_ENABLED=true to enable');
}

// Export for manual triggering
module.exports = {
  updateFees,
  UPDATE_INTERVAL_MS
};