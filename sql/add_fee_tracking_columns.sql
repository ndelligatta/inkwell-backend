-- Add fee tracking columns to user_posts table
ALTER TABLE public.user_posts 
ADD COLUMN IF NOT EXISTS total_fees_generated_all_time DECIMAL(20,9) DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_fees_claimed DECIMAL(20,9) DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_fee_update_at TIMESTAMP DEFAULT NOW();

-- Create index for faster fee queries
CREATE INDEX IF NOT EXISTS idx_user_posts_fees 
ON public.user_posts (total_fees_generated_all_time DESC) 
WHERE total_fees_generated_all_time > 0;