-- Add lifetime fees generated column to users table
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS lifetime_fees_generated DECIMAL(20,9) DEFAULT 0;

-- Add index for better performance when querying
CREATE INDEX IF NOT EXISTS idx_users_lifetime_fees ON public.users(lifetime_fees_generated);

-- Add comment to describe the column
COMMENT ON COLUMN public.users.lifetime_fees_generated IS 'Total lifetime fees generated across all user posts in SOL';