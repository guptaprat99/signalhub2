# SignalHub Workflow Documentation

## Project Overview

SignalHub is a trading signals and market data platform that fetches OHLC (Open, High, Low, Close) data from the Dhan API, computes technical indicators (EMA), and provides trend analysis for Indian stock markets. The system operates on a Next.js frontend with Supabase backend and edge functions.

## Architecture

### Technology Stack
- **Frontend**: Next.js 14 with TypeScript, Tailwind CSS
- **Backend**: Supabase (PostgreSQL database, Edge Functions)
- **Data Source**: Dhan API for Indian market data
- **Deployment**: Supabase Edge Functions (Deno runtime)

### Database Schema
- `stocks`: Stock information (symbol, security_id, exchange_segment, etc.)
- `ohlc_data`: OHLC price data with timestamps
- `indicators`: Technical indicators configuration (EMA periods)
- `signals`: Computed indicator values
- `9_30_ema_trend`: EMA trend analysis and crossover detection

## Data Flow Workflow

### 1. Data Ingestion Pipeline

#### 1.1 Automated Data Fetching
- **Trigger**: Cron job runs every 5 minutes during market hours (09:15-15:30 IST)
- **Function**: `fetch_ohlc` Edge Function
- **Process**:
  1. Fetches all active stocks from database
  2. For each stock, retrieves OHLC data from Dhan API
  3. Supports multiple timeframes (5-minute, 1-hour intervals)
  4. Filters data to market hours only (09:15-15:30 IST)
  5. Stores data in `ohlc_data` table with deduplication
  6. Maintains only the latest 210 candles per stock/timeframe

#### 1.2 Manual Data Refresh
- **Trigger**: User clicks "Refresh & Compute Signals" button
- **Function**: `pipeline` Edge Function orchestrates the entire workflow
- **Process**: Runs all processing steps in sequence

### 2. Signal Computation Pipeline

#### 2.1 EMA Calculation
- **Function**: `compute_signals` Edge Function
- **Process**:
  1. Fetches all active EMA indicators from database
  2. For each stock/timeframe pair, retrieves OHLC data
  3. Computes EMA values using TradingView-style algorithm
  4. Stores signals in `signals` table
  5. Maintains only the latest 50 signals per indicator/stock/timeframe

#### 2.2 9-30 EMA Trend Analysis
- **Function**: `compute_ema_trend` Edge Function
- **Process**:
  1. Processes 9 EMA and 30 EMA signals
  2. Computes trend direction (Bullish/Bearish)
  3. Detects crossover events (Bullish/Bearish crossovers)
  4. Stores results in `9_30_ema_trend` table
  5. Maintains only the latest 50 trend records per stock/timeframe

#### 2.3 9-30 EMA Strategy Aggregation
- **Function**: `populate_strategy_9_30_ema` Edge Function
- **Process**:
  1. Fetches latest CMP (current market price) per symbol
  2. Calculates percentage change from previous day close
  3. Aggregates latest trends and crossovers for 5min and 60min timeframes
  4. Populates `strategy_9_30_ema` table with flattened strategy data
  5. Provides real-time 9-30 EMA strategy dashboard view

### 3. Frontend Display

#### 3.1 OHLC Data Page (`/ohlc`)
- Displays real-time OHLC data in tabular format
- Features:
  - Auto-refresh capability (2-minute intervals)
  - Symbol and timeframe filtering
  - Manual refresh trigger
  - IST timestamp display
  - Volume formatting

#### 3.2 9-30 EMA Strategy Page (`/9-30-ema`)
- Real-time 9-30 EMA strategy analysis dashboard
- Features:
  - Current market price (CMP) display
  - Percentage change calculations
  - 5-minute and 60-minute EMA trends
  - Crossover event timestamps
  - Auto-refresh capability (2-minute intervals)
  - Color-coded trend indicators
  - Comprehensive strategy data table



## Processing Workflow

### Step-by-Step Execution

1. **Data Fetching** (`fetch_ohlc`)
   ```
   Stocks Database → Dhan API → OHLC Data → Supabase Storage
   ```

2. **Signal Computation** (`compute_signals`)
   ```
   OHLC Data → EMA Calculation → Signal Storage
   ```

3. **9-30 EMA Trend Analysis** (`compute_ema_trend`)
   ```
   EMA Signals → Trend Detection → Crossover Analysis → Trend Storage
   ```

4. **Pipeline Orchestration** (`pipeline`)
   ```
   fetch_ohlc → compute_signals → compute_ema_trend → populate_strategy_9_30_ema
   ```

### Error Handling

- Each function includes comprehensive error handling
- Failed operations are logged with detailed error messages
- Rate limiting implemented for API calls (1.1s between requests)
- Graceful degradation when data is unavailable

### Data Management

- **Deduplication**: Uses upsert operations with conflict resolution
- **Data Retention**: Maintains only recent data (50-210 records per entity)
- **Cleanup**: Automatic pruning of old records
- **Filtering**: Market hours and trading days filtering

## Configuration

### Environment Variables
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key for database access
- `DHAN_API_TOKEN`: Dhan API access token
- `NEXT_PUBLIC_SUPABASE_URL`: Public Supabase URL for frontend
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Anonymous key for frontend

### Cron Schedule
```yaml
# Runs every 5 minutes during market hours
- function: fetch_ohlc
  cron: '*/5 3-9 * * 1-5'   # 03:00–09:59 UTC, Mon–Fri
- function: fetch_ohlc
  cron: '0,5,10,15,20,25,30,35,40,45,50,55 10 * * 1-5' # 10:00–10:55 UTC
```

## Development Workflow

### Local Development
1. Clone repository
2. Install dependencies: `npm install`
3. Set up environment variables
4. Run development server: `npm run dev`

### Edge Function Development
1. Functions located in `supabase/functions/`
2. Use Deno runtime for edge functions
3. Deploy with Supabase CLI
4. Test with individual function calls

### Database Schema Management
- Schema defined in Supabase dashboard
- Tables: stocks, ohlc_data, indicators, signals, 9_30_ema_trend
- Proper indexing for performance
- Foreign key relationships maintained

## Monitoring and Maintenance

### Performance Considerations
- Rate limiting for API calls
- Batch processing for large datasets
- Efficient data retention policies
- Proper indexing on database tables

### Error Monitoring
- Function execution logs in Supabase dashboard
- Error tracking in frontend console
- Failed operation reporting

### Data Quality
- Market hours filtering
- Trading days validation
- Data completeness checks
- Duplicate prevention

## Future Enhancements

### Planned Features
1. Real-time chart visualization
2. Advanced technical indicators
3. Alert system for crossovers
4. Historical data analysis
5. Portfolio tracking
6. Backtesting capabilities

### Scalability Considerations
- Horizontal scaling with multiple edge functions
- Database optimization for large datasets
- Caching strategies for frequently accessed data
- API rate limit management

## Security Considerations

- API keys stored as environment variables
- Service role keys used only in backend functions
- Anonymous keys for frontend access
- CORS configuration for cross-origin requests
- Input validation and sanitization

This workflow ensures reliable data processing, efficient storage, and responsive user interface for the SignalHub trading platform. 