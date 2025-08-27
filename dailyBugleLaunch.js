// Daily Bugle Token Launcher - Hardcoded version
const tokenLauncherImproved = require('./tokenLauncherImproved');
const fs = require('fs');
const path = require('path');

// Hardcoded Daily Bugle user ID
const DAILY_BUGLE_USER_ID = 'a6a3bf15-2af5-4b8f-99d3-e567db6c99f7';
const DAILY_BUGLE_DEV_WALLET_PRIVATE_KEY = 'CMyvj8J+HdTVMjTch3vEMzA7fAC4r7/FGIpsxxSm6rFTObiIuDOsr8AxQpD6tTBB9n8RFUsbuZKNb9jSdcOLdQ==';

// Load and convert the Daily Bugle image to base64
function getDailyBugleImage() {
  try {
    // Try to load the image from a local file
    const imagePath = path.join(__dirname, 'daily-bugle-logo.png');
    if (fs.existsSync(imagePath)) {
      const imageBuffer = fs.readFileSync(imagePath);
      return imageBuffer.toString('base64');
    }
  } catch (error) {
    console.log('Could not load local image, using fallback');
  }
  
  // Fallback: Use a base64 encoded version of the Daily Bugle logo
  // This is a simplified black and white logo placeholder
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
}

async function launchDailyBugleToken() {
  console.log('🗞️ Launching Daily Bugle Token...');
  
  // Hardcoded metadata
  const metadata = {
    name: 'DAILYBUGLE',
    symbol: 'BUGLE',
    description: 'The official token of The Daily Bugle - Your trusted source for all things crypto news! Get your daily dose of Web3 journalism. 🗞️📰',
    image: getDailyBugleImage(),
    imageType: 'image/png',
    website: 'https://dailybugle.news',
    twitter: 'https://twitter.com/dailybugleco',
    initialBuyAmount: 0.01 // Dev buy of 0.01 SOL
  };
  
  try {
    console.log('Metadata prepared:', {
      name: metadata.name,
      symbol: metadata.symbol,
      initialBuyAmount: metadata.initialBuyAmount
    });
    
    // Call the original token launcher with our hardcoded values
    const result = await tokenLauncherImproved.launchTokenDBC(
      metadata,
      DAILY_BUGLE_USER_ID,
      DAILY_BUGLE_DEV_WALLET_PRIVATE_KEY
    );
    
    if (result.success) {
      console.log('✅ Daily Bugle Token launched successfully!');
      console.log('🪙 Mint Address:', result.mintAddress);
      console.log('🌊 Pool Address:', result.poolAddress);
      console.log('📝 Transaction:', result.transactionSignature);
      console.log('🔍 Explorer:', result.explorerUrl);
      console.log('📰 Post ID:', result.postId);
    } else {
      console.error('❌ Failed to launch Daily Bugle Token:', result.error);
    }
    
    return result;
  } catch (error) {
    console.error('💥 Error launching Daily Bugle Token:', error);
    return {
      success: false,
      error: error.message || 'Unknown error occurred'
    };
  }
}

// Export the function
module.exports = {
  launchDailyBugleToken
};

// If running directly, execute the launch
if (require.main === module) {
  launchDailyBugleToken()
    .then(result => {
      console.log('\n📊 Final result:', JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('\n💥 Fatal error:', error);
      process.exit(1);
    });
}