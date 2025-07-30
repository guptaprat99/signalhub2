# SignalHub2 Delta Processing - Debug & Test Guide

## 🚨 Emergency Debugging Prompt

If the delta processing pipeline isn't working as expected, use this comprehensive debugging guide.

---

## 📋 Pre-Test Checklist

### 1. Verify Database Setup
```sql
-- Check if processing_state table exists and has correct structure
SELECT 
  table_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns 
WHERE table_name = 'processing_state'
ORDER BY ordinal_position;

-- Check if table has any data
SELECT COUNT(*) as total_records FROM processing_state;
```

### 2. Verify Required Tables Exist
```sql
-- Check all required tables
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('stocks', 'ohlc_data', 'signals', '9_30_ema_trend', 'indicators', 'processing_state')
ORDER BY table_name;
```

### 3. Check Function Deployment Status
```bash
# List all deployed functions
supabase functions list

# Check function logs (if available)
supabase functions logs fetch_ohlc
supabase functions logs compute_signals
supabase functions logs compute_ema_trend
supabase functions logs populate_strategy_9_30_ema
supabase functions logs pipeline
```

---

## 🧪 Step-by-Step Testing Protocol

### Phase 1: Basic Function Testing

#### Test 1: Individual Function Health Check
```bash
# Test each function individually with curl
curl -X POST "https://mxdyomqyvrwytuqzpvwk.functions.supabase.co/fetch_ohlc" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHlvbXF5dnJ3eXR1cXpwdndrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Mjc0NTYwNCwiZXhwIjoyMDY4MzIxNjA0fQ.154JeqiY0r649DJGaMUpXE6CvNU_fFPB1SXKVx5vld0" \
  -H "Content-Type: application/json"

curl -X POST "https://mxdyomqyvrwytuqzpvwk.functions.supabase.co/compute_signals" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHlvbXF5dnJ3eXR1cXpwdndrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Mjc0NTYwNCwiZXhwIjoyMDY4MzIxNjA0fQ.154JeqiY0r649DJGaMUpXE6CvNU_fFPB1SXKVx5vld0" \
  -H "Content-Type: application/json"

curl -X POST "https://mxdyomqyvrwytuqzpvwk.functions.supabase.co/compute_ema_trend" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHlvbXF5dnJ3eXR1cXpwdndrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Mjc0NTYwNCwiZXhwIjoyMDY4MzIxNjA0fQ.154JeqiY0r649DJGaMUpXE6CvNU_fFPB1SXKVx5vld0" \
  -H "Content-Type: application/json"

curl -X POST "https://mxdyomqyvrwytuqzpvwk.functions.supabase.co/populate_strategy_9_30_ema" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHlvbXF5dnJ3eXR1cXpwdndrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Mjc0NTYwNCwiZXhwIjoyMDY4MzIxNjA0fQ.154JeqiY0r649DJGaMUpXE6CvNU_fFPB1SXKVx5vld0" \
  -H "Content-Type: application/json"
```

**Expected Results:**
- All functions should return `{"success": true, ...}`
- No 401/500 errors
- Functions should process data and update processing_state

#### Test 2: Pipeline Function Test
```bash
# Test the full pipeline
curl -X POST "https://mxdyomqyvrwytuqzpvwk.functions.supabase.co/pipeline" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHlvbXF5dnJ3eXR1cXpwdndrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Mjc0NTYwNCwiZXhwIjoyMDY4MzIxNjA0fQ.154JeqiY0r649DJGaMUpXE6CvNU_fFPB1SXKVx5vld0" \
  -H "Content-Type: application/json"
```

**Expected Results:**
- All 4 steps should return `{"ok": true, "status": 200}`
- Processing should be faster on subsequent runs

### Phase 2: Delta Processing Verification

#### Test 3: Check Processing State After First Run
```sql
-- Check if processing_state was populated after first run
SELECT 
  function_name,
  COUNT(*) as records,
  MIN(last_run_at) as first_run,
  MAX(last_run_at) as last_run
FROM processing_state 
GROUP BY function_name
ORDER BY function_name;

-- Check specific processing states
SELECT 
  function_name,
  stock_id,
  timeframe,
  last_processed_timestamp,
  last_run_at,
  status
FROM processing_state 
ORDER BY function_name, stock_id, timeframe;
```

**Expected Results:**
- Should have records for all 4 functions
- `last_processed_timestamp` should be recent
- `status` should be 'completed'

#### Test 4: Second Run Delta Processing Test
```bash
# Run pipeline again (should be faster)
curl -X POST "https://mxdyomqyvrwytuqzpvwk.functions.supabase.co/pipeline" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHlvbXF5dnJ3eXR1cXpwdndrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Mjc0NTYwNCwiZXhwIjoyMDY4MzIxNjA0fQ.154JeqiY0r649DJGaMUpXE6CvNU_fFPB1SXKVx5vld0" \
  -H "Content-Type: application/json"
```

**Expected Results:**
- Should be much faster than first run
- Should process fewer candles/signals/trends
- May show "Skipping" messages in logs

### Phase 3: Data Verification

#### Test 5: Verify Data Integrity
```sql
-- Check OHLC data
SELECT 
  'OHLC Data' as table_name,
  COUNT(*) as total_records,
  COUNT(DISTINCT stock_id) as unique_stocks,
  COUNT(DISTINCT timeframe) as unique_timeframes,
  MIN(timestamp) as earliest,
  MAX(timestamp) as latest
FROM ohlc_data;

-- Check signals data
SELECT 
  'Signals Data' as table_name,
  COUNT(*) as total_records,
  COUNT(DISTINCT stock_id) as unique_stocks,
  COUNT(DISTINCT timeframe) as unique_timeframes
FROM signals;

-- Check trend data
SELECT 
  'Trend Data' as table_name,
  COUNT(*) as total_records,
  COUNT(DISTINCT stock_id) as unique_stocks,
  COUNT(DISTINCT timeframe) as unique_timeframes
FROM "9_30_ema_trend";

-- Check strategy data
SELECT 
  'Strategy Data' as table_name,
  COUNT(*) as total_records,
  COUNT(DISTINCT stock_id) as unique_stocks
FROM strategy_9_30_ema;
```

---

## 🔧 Troubleshooting Guide

### Issue 1: Functions Return 401 Errors
**Problem:** Authentication failed
**Solution:**
```bash
# Verify service role key is correct
# Get fresh key from Supabase Dashboard → Settings → API → service_role
```

### Issue 2: Functions Return 500 Errors
**Problem:** Function execution failed
**Solution:**
```bash
# Check function logs
supabase functions logs [function_name]

# Redeploy functions
supabase functions deploy fetch_ohlc
supabase functions deploy compute_signals
supabase functions deploy compute_ema_trend
supabase functions deploy populate_strategy_9_30_ema
supabase functions deploy pipeline
```

### Issue 3: Processing State Table Empty
**Problem:** Delta processing not working
**Solution:**
```sql
-- Check if table exists and has correct structure
\d processing_state

-- Manually test processing state operations
INSERT INTO processing_state (
  function_name, stock_id, timeframe, last_processed_timestamp, status
) VALUES (
  'test', 1, '5', NOW(), 'completed'
);

-- Check if insert worked
SELECT * FROM processing_state WHERE function_name = 'test';

-- Clean up test
DELETE FROM processing_state WHERE function_name = 'test';
```

### Issue 4: No Data Being Processed
**Problem:** Functions not finding data to process
**Solution:**
```sql
-- Check if stocks exist
SELECT * FROM stocks LIMIT 5;

-- Check if OHLC data exists
SELECT * FROM ohlc_data LIMIT 5;

-- Check if indicators exist
SELECT * FROM indicators WHERE name IN ('9 EMA', '30 EMA');
```

### Issue 5: Functions Process Same Data Repeatedly
**Problem:** Delta processing not working
**Solution:**
```sql
-- Check processing state timestamps
SELECT 
  function_name,
  stock_id,
  timeframe,
  last_processed_timestamp,
  last_run_at
FROM processing_state 
ORDER BY function_name, stock_id, timeframe;

-- Compare with actual data timestamps
SELECT 
  stock_id,
  timeframe,
  MIN(timestamp) as earliest,
  MAX(timestamp) as latest,
  COUNT(*) as total_records
FROM ohlc_data 
GROUP BY stock_id, timeframe
ORDER BY stock_id, timeframe;
```

---

## 📊 Performance Monitoring

### Expected Performance Metrics
- **First Run**: 2,000+ candles, 1,400+ signals, 250+ trends
- **Second Run**: 0-50 candles, 0-50 signals, 0-50 trends
- **Processing Time**: Second run should be 90%+ faster

### Monitoring Queries
```sql
-- Monitor processing state updates
SELECT 
  function_name,
  COUNT(*) as total_records,
  AVG(EXTRACT(EPOCH FROM (last_run_at - created_at))) as avg_processing_time_seconds
FROM processing_state 
GROUP BY function_name;

-- Monitor data growth
SELECT 
  'ohlc_data' as table_name,
  COUNT(*) as records,
  MAX(timestamp) as latest_data
FROM ohlc_data
UNION ALL
SELECT 
  'signals' as table_name,
  COUNT(*) as records,
  MAX(timestamp) as latest_data
FROM signals
UNION ALL
SELECT 
  '9_30_ema_trend' as table_name,
  COUNT(*) as records,
  MAX(timestamp) as latest_data
FROM "9_30_ema_trend";
```

---

## 🚀 Success Criteria

The delta processing is working correctly if:

1. ✅ **All functions deploy and run without errors**
2. ✅ **Processing state table gets populated after first run**
3. ✅ **Second run processes significantly less data**
4. ✅ **Processing time reduces by 90%+ on subsequent runs**
5. ✅ **No duplicate data is processed**
6. ✅ **Functions handle no-new-data scenarios gracefully**

---

## 📞 Emergency Contact

If all else fails:
1. Check Supabase function logs in dashboard
2. Verify all environment variables are set correctly
3. Redeploy all functions
4. Test with individual functions first, then pipeline
5. Use the SQL queries above to verify data integrity

**Remember:** The empty processing_state table after first run is normal if no new data is available. The key is to test during market hours when new data is being fetched. 