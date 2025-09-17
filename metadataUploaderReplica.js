// Replica of the working metadata/image uploader used by the create-coin flow.
// This module intentionally mirrors tokenLauncherImproved.js upload shape
// without importing from it, so we don't risk changing the working file.

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || (!SUPABASE_ANON_KEY && !SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error('Missing Supabase credentials for metadata uploader');
}

// Prefer service role for storage operations (same as working flow)
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

/**
 * Upload image and metadata to Supabase storage with mint-based filenames
 * @param {{
 *   name: string,
 *   symbol: string,
 *   description?: string,
 *   website?: string,
 *   twitter?: string,
 *   image?: Buffer,
 *   imageType?: string
 * }} metadata
 * @param {string} mintAddress
 * @returns {Promise<string>} metadata public URL
 */
async function uploadMetadataReplica(metadata, mintAddress) {
  // Step 1: upload image (if provided) to posts/token-<mint>.png
  let imageUrl = null;
  if (metadata.image && Buffer.isBuffer(metadata.image)) {
    const filePath = `posts/token-${mintAddress}.png`;
    const fileBuffer = metadata.image;

    // Validate file size (same constraint as working flow)
    if (fileBuffer.length > 10 * 1024 * 1024) {
      throw new Error('Image file too large. Maximum size is 10MB.');
    }

    const { error: uploadError } = await supabase.storage
      .from('post-media')
      .upload(filePath, fileBuffer, {
        cacheControl: '3600',
        upsert: true,
        contentType: metadata.imageType || 'image/png'
      });
    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from('post-media')
      .getPublicUrl(filePath);
    imageUrl = urlData.publicUrl;
    // Validate image URL is reachable and has correct content-type
    const headImg = await axios.head(imageUrl, { timeout: 10000, validateStatus: () => true });
    if (headImg.status !== 200 || String(headImg.headers['content-type'] || '').indexOf('image') === -1) {
      throw new Error(`Image URL not ready or wrong content-type: ${imageUrl} (${headImg.status})`);
    }
  }

  // Step 2: build metadata JSON (exact shape used by working flow)
  const json = {
    name: (metadata.name || '').substring(0, 32),
    symbol: (metadata.symbol || '').substring(0, 10),
    description: (metadata.description || '').substring(0, 500),
    image: imageUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${mintAddress}`,
    attributes: [],
    properties: {
      files: imageUrl ? [{ uri: imageUrl, type: metadata.imageType || 'image/png' }] : [],
      category: 'image',
      creators: []
    }
  };

  if (metadata.website) json.external_url = metadata.website;

  const social = {};
  if (metadata.twitter) {
    social.twitter = metadata.twitter;
    json.attributes.push({ trait_type: 'twitter', value: metadata.twitter });
  }
  if (metadata.website) {
    social.website = metadata.website;
    json.attributes.push({ trait_type: 'website', value: metadata.website });
  }
  if (Object.keys(social).length > 0) json.extensions = social;

  // Step 3: upload metadata JSON
  const metadataPath = `posts/token-metadata-${mintAddress}.json`;
  const { error: metaError } = await supabase.storage
    .from('post-media')
    .upload(metadataPath, Buffer.from(JSON.stringify(json, null, 2)), {
      cacheControl: '3600',
      upsert: true,
      contentType: 'application/json'
    });
  if (metaError) throw metaError;

  const { data: metadataUrlData } = supabase.storage
    .from('post-media')
    .getPublicUrl(metadataPath);
  const metadataUrl = metadataUrlData.publicUrl;
  // Validate metadata URL is reachable and JSON
  const headMeta = await axios.head(metadataUrl, { timeout: 10000, validateStatus: () => true });
  if (headMeta.status !== 200 || String(headMeta.headers['content-type'] || '').indexOf('application/json') === -1) {
    throw new Error(`Metadata URL not ready or wrong content-type: ${metadataUrl} (${headMeta.status})`);
  }

  // Optionally parse JSON for shape assertions
  try {
    const getMeta = await axios.get(metadataUrl, { timeout: 10000 });
    const meta = getMeta.data || {};
    if (!meta.image || (meta.properties && Array.isArray(meta.properties.files) && meta.properties.files.length > 0 && !meta.properties.files[0].type)) {
      throw new Error('Metadata JSON missing image or file type');
    }
  } catch (e) {
    throw new Error(`Metadata JSON fetch/validate failed: ${e?.message || e}`);
  }

  return { metadataUrl, imageUrl };
}

module.exports = { uploadMetadataReplica };
