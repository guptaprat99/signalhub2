# Testing Guide for Delta Processing Pipeline

## ✅ What's Been Completed

1. **Database Migration**: `processing_state` table created manually in Supabase
2. **Functions Deployed**: All functions successfully deployed
3. **Syntax Errors Fixed**: compute_ema_trend function fixed and deployed

## 🧪 How to Test the Pipeline

### Option 1: Via Supabase Dashboard (Recommended)

1. **Go to your Supabase Dashboard**: https://supabase.com/dashboard/project/mxdyomqyvrwytuqzpvwk
2. **Navigate to Edge Functions**
3. **Find the `pipeline` function**
4. **Click "Invoke"** to run the pipeline
5. **Check the logs** to see the delta processing in action

### Option 2: Via HTTP Request

You'll need your `SUPABASE_SERVICE_ROLE_KEY` from the Supabase dashboard:

1. **Get your Service Role Key**:
   - Go to Settings → API in your Supabase dashboard
   - Copy the `service_role` key (not the anon key)

2. **Test the pipeline**:
   ```bash
   curl -X POST "https://mxdyomqyvrwytuqzpvwk.functions.supabase.co/pipeline" \
     -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
     -H "Content-Type: application/json"
   ```

### Option 3: Test Individual Functions

Test each function individually to see delta processing:

```bash
# Test fetch_ohlc
curl -X POST "https://mxdyomqyvrwytuqzpvwk.functions.supabase.co/fetch_ohlc" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json"

# Test compute_signals
curl -X POST "https://mxdyomqyvrwytuqzpvwk.functions.supabase.co/compute_signals" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json"

# Test compute_ema_trend
curl -X POST "https://mxdyomqyvrwytuqzpvwk.functions.supabase.co/compute_ema_trend" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json"

# Test populate_strategy_9_30_ema
curl -X POST "https://mxdyomqyvrwytuqzpvwk.functions.supabase.co/populate_strategy_9_30_ema" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json"
```

## 📊 What to Look For

### Expected Log Messages (Delta Processing Working):

1. **fetch_ohlc**:
   - `"Skipping {stock_id}/{timeframe}: Recent data available"` (smart fetching)
   - `"Fetched {count} new candles for {stock_id}/{timeframe}"` (delta processing)

2. **compute_signals**:
   - `"No new data for {stock_id}/{timeframe}, skipping"` (normal)
   - `"Processed {count} new candles for {stock_id}/{timeframe}"` (delta processing)

3. **compute_ema_trend**:
   - `"No new data for {stock_id}/{timeframe}, skipping"` (normal)
   - `"Generated {count} trend records for {stock_id}/{timeframe}"` (delta processing)

4. **populate_strategy_9_30_ema**:
   - `"Rebuilt strategy table with {count} stocks"` (full rebuild - correct)

### Performance Indicators:

- **First Run**: Will process all historical data (slower)
- **Subsequent Runs**: Should be much faster, only processing new data
- **Processing Time**: Should be significantly reduced after first run

## 🔍 Troubleshooting

### If Functions Return 401 Errors:
- Check that you're using the `service_role` key, not the `anon` key
- Verify the key is correct in Supabase dashboard

### If Functions Return 500 Errors:
- Check the function logs in Supabase dashboard
- Verify that all required tables exist (`processing_state`, `ohlc_data`, `stocks`, etc.)

### If No Data is Processed:
- Check if you have stocks configured in the `stocks` table
- Verify that `ohlc_data` table has data
- Check if indicators exist in the `indicators` table

## 🎯 Success Criteria

The delta processing is working correctly if:

1. **First run**: Processes all historical data and creates initial processing states
2. **Second run**: Only processes new data since last run (much faster)
3. **Logs show**: "Skipping" messages for stocks with no new data
4. **Performance**: Subsequent runs are significantly faster than the first run

## 📈 Monitoring

After testing, you can monitor the pipeline by:

1. **Checking processing_state table**: See what was last processed
2. **Function logs**: View detailed execution logs
3. **Data tables**: Verify that new data is being added correctly
4. **Performance**: Compare processing times between runs 