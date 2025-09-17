// Provides the spam token image as base64. No fallbacks.
// Set SPAM_IMAGE_BASE64 in the environment (raw base64, no data URL prefix).

function getSpamTokenImageBase64() {
  const b64 = (process.env.SPAM_IMAGE_BASE64 || '').trim();
  if (!b64) {
    throw new Error('SPAM_IMAGE_BASE64 not set. Provide the PNG as base64 (no data URL prefix).');
  }
  return b64;
}

module.exports = { getSpamTokenImageBase64 };

