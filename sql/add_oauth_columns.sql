-- Add OAuth authentication columns to users table
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS oauth_identifier TEXT UNIQUE,
ADD COLUMN IF NOT EXISTS email TEXT UNIQUE,
ADD COLUMN IF NOT EXISTS auth_provider TEXT,
ADD COLUMN IF NOT EXISTS privy_user_id TEXT UNIQUE;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_users_oauth_identifier ON public.users(oauth_identifier);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_privy_user_id ON public.users(privy_user_id);

-- Update RLS policies to allow OAuth and email based auth
-- Drop existing policies first
DROP POLICY IF EXISTS "Users can view their own profile" ON public.users;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.users;
DROP POLICY IF EXISTS "Anyone can view user profiles" ON public.users;

-- Create new policies that support multiple auth methods
CREATE POLICY "Anyone can view user profiles" ON public.users
  FOR SELECT
  USING (true);

CREATE POLICY "Users can update their own profile" ON public.users
  FOR UPDATE
  USING (
    id::text = current_setting('request.jwt.claims', true)::json->>'sub' OR
    wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address' OR
    oauth_identifier = current_setting('request.jwt.claims', true)::json->>'oauth_identifier' OR
    email = current_setting('request.jwt.claims', true)::json->>'email' OR
    id::text = current_setting('app.current_user_id', true)
  );

CREATE POLICY "Users can insert their own profile" ON public.users
  FOR INSERT
  WITH CHECK (true);

-- Add migration to update existing users with auth_provider
UPDATE public.users 
SET auth_provider = 'wallet' 
WHERE wallet_address IS NOT NULL AND auth_provider IS NULL;