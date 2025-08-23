-- Add config_address column to user_posts table
ALTER TABLE public.user_posts 
ADD COLUMN IF NOT EXISTS config_address TEXT NULL;

-- Create index for config_address for better query performance
CREATE INDEX IF NOT EXISTS idx_user_posts_config_address 
ON public.user_posts USING btree (config_address) 
TABLESPACE pg_default
WHERE (config_address IS NOT NULL);

-- Add comment to document the column
COMMENT ON COLUMN public.user_posts.config_address IS 'The config address used for the token pool (e.g., DBC config)';