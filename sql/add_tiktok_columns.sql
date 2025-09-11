-- Add TikTok integration columns to users table (idempotent)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS tiktok_open_id text,
  ADD COLUMN IF NOT EXISTS tiktok_username text,
  ADD COLUMN IF NOT EXISTS tiktok_avatar_url text,
  ADD COLUMN IF NOT EXISTS tiktok_access_token text,
  ADD COLUMN IF NOT EXISTS tiktok_refresh_token text,
  ADD COLUMN IF NOT EXISTS tiktok_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS tiktok_scopes text;

