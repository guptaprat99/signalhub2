-- Create processing_state table for tracking delta processing
-- This table tracks the last processed timestamp for each function/stock/timeframe combination

CREATE TABLE IF NOT EXISTS processing_state (
  id SERIAL PRIMARY KEY,
  function_name TEXT NOT NULL,
  stock_id INTEGER NOT NULL,
  timeframe TEXT NOT NULL,
  last_processed_timestamp TIMESTAMP WITH TIME ZONE,
  last_run_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status TEXT DEFAULT 'completed' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Ensure unique combination of function, stock, and timeframe
  UNIQUE(function_name, stock_id, timeframe)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_processing_state_function_stock_timeframe 
ON processing_state(function_name, stock_id, timeframe);

CREATE INDEX IF NOT EXISTS idx_processing_state_last_processed 
ON processing_state(last_processed_timestamp);

CREATE INDEX IF NOT EXISTS idx_processing_state_status 
ON processing_state(status);

-- Add RLS policies if needed (adjust based on your security requirements)
-- ALTER TABLE processing_state ENABLE ROW LEVEL SECURITY;

-- Create a function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_processing_state_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER trigger_update_processing_state_updated_at
  BEFORE UPDATE ON processing_state
  FOR EACH ROW
  EXECUTE FUNCTION update_processing_state_updated_at();

-- Add comments for documentation
COMMENT ON TABLE processing_state IS 'Tracks the last processed timestamp for each function/stock/timeframe combination to enable delta processing';
COMMENT ON COLUMN processing_state.function_name IS 'Name of the function (e.g., compute_signals, compute_ema_trend)';
COMMENT ON COLUMN processing_state.stock_id IS 'Stock ID from stocks table';
COMMENT ON COLUMN processing_state.timeframe IS 'Timeframe (e.g., 5, 60)';
COMMENT ON COLUMN processing_state.last_processed_timestamp IS 'Last OHLC timestamp that was processed by this function';
COMMENT ON COLUMN processing_state.last_run_at IS 'When this function last ran for this stock/timeframe';
COMMENT ON COLUMN processing_state.status IS 'Current status: pending, processing, completed, failed'; 