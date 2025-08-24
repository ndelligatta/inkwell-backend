-- Add fee tracking columns to user_posts table
ALTER TABLE public.user_posts 
ADD COLUMN IF NOT EXISTS total_fees_generated_all_time DECIMAL(20,9) DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_fees_claimed DECIMAL(20,9) DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_fee_update_at TIMESTAMP DEFAULT NOW();

-- Create index for faster fee queries
CREATE INDEX IF NOT EXISTS idx_user_posts_fees 
ON public.user_posts (total_fees_generated_all_time DESC) 
WHERE total_fees_generated_all_time > 0;

-- Create table to track fee events from webhooks
CREATE TABLE IF NOT EXISTS fee_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_address VARCHAR(255) NOT NULL,
  post_id UUID REFERENCES user_posts(id) ON DELETE CASCADE,
  transaction_signature VARCHAR(255) UNIQUE NOT NULL,
  fee_amount_sol DECIMAL(20,9) NOT NULL,
  swap_amount_sol DECIMAL(20,9),
  event_type VARCHAR(50) DEFAULT 'swap',
  raw_data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_fee_events_pool ON fee_webhook_events(pool_address);
CREATE INDEX idx_fee_events_signature ON fee_webhook_events(transaction_signature);

-- Function to update fees atomically
CREATE OR REPLACE FUNCTION update_pool_fees(
  p_pool_address VARCHAR,
  p_fee_amount_sol DECIMAL,
  p_transaction_signature VARCHAR
) RETURNS BOOLEAN AS $$
DECLARE
  v_post_id UUID;
BEGIN
  -- Get post ID
  SELECT id INTO v_post_id 
  FROM user_posts 
  WHERE pool_address = p_pool_address 
  LIMIT 1;
  
  IF v_post_id IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Insert fee event (skip if duplicate)
  INSERT INTO fee_webhook_events (
    pool_address,
    post_id,
    transaction_signature,
    fee_amount_sol
  ) VALUES (
    p_pool_address,
    v_post_id,
    p_transaction_signature,
    p_fee_amount_sol
  ) ON CONFLICT (transaction_signature) DO NOTHING;
  
  -- Update post totals
  UPDATE user_posts
  SET 
    total_fees_generated_all_time = total_fees_generated_all_time + p_fee_amount_sol,
    last_fee_update_at = NOW()
  WHERE pool_address = p_pool_address;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Table to track webhook registrations
CREATE TABLE IF NOT EXISTS pool_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_address VARCHAR(255) NOT NULL UNIQUE,
  post_id UUID REFERENCES user_posts(id) ON DELETE CASCADE,
  webhook_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  last_event_at TIMESTAMP
);

CREATE INDEX idx_pool_webhooks_address ON pool_webhooks(pool_address);
CREATE INDEX idx_pool_webhooks_status ON pool_webhooks(status);