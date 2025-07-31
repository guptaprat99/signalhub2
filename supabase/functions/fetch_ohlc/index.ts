/// <reference types="deno.ns" />
// Supabase Edge Function: Fetch OHLC data from Dhan and store in Supabase (Delta Processing + Parallel)
// Deno runtime
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { fetchOHLC } from "../../../utils/fetchOHLC.ts";
import { 
  getStockTimeframePairs, 
  getPipelineLastProcessedTimestamp
} from "../shared/processing_state.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DHAN_API_TOKEN = Deno.env.get("DHAN_API_TOKEN")!;

// Helper: Supabase fetch with auth headers
function supabaseFetch(path: string, options: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates", // for upsert
    },
  });
}

// Helper: Get last N trading days (skipping weekends, optionally holidays)
function getLastNTradingDays(n, holidays = []) {
  const days = [];
  let d = new Date();
  while (days.length < n) {
    // Convert to IST (UTC+5:30)
    const istDate = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    const day = istDate.getUTCDay();
    const dateStr = istDate.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !holidays.includes(dateStr)) {
      days.unshift(dateStr); // add to start
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return days;
}

// Lookup: Candles per day for each interval
const CANDLES_PER_DAY: Record<string, number> = {
  "5": 75,   // 5-min interval: 75 candles per day (9:15-15:30 IST)
  "60": 7,   // 1-hr interval: 7 candles per day (9:15-15:30 IST)
};

// Helper: Get fromDate and toDate for last N candles (5-min interval)
function getDateRangeForLastNCandles(nCandles, interval, holidays = []) {
  const candlesPerDay = CANDLES_PER_DAY[interval];
  if (!candlesPerDay) throw new Error(`Unsupported interval: ${interval}`);
  const daysNeeded = Math.ceil(nCandles / candlesPerDay) + 2; // +2 for safety
  const tradingDays = getLastNTradingDays(daysNeeded, holidays);
  const fromDate = tradingDays[0];
  const toDate = tradingDays[tradingDays.length - 1];
  return { fromDate, toDate, tradingDays };
}

function getFromDateForNCandles(nCandles, interval, holidays = []) {
  const candlesPerDay = CANDLES_PER_DAY[interval];
  if (!candlesPerDay) throw new Error(`Unsupported interval: ${interval}`);
  const tradingDaysNeeded = Math.ceil(nCandles / candlesPerDay);
  const tradingDays = getLastNTradingDays(tradingDaysNeeded, holidays);
  // Dhan expects IST datetime in 'YYYY-MM-DD HH:mm:ss' format, market open 09:15:00 IST
  const fromDate = `${tradingDays[0]} 09:15:00`;
  return fromDate;
}

function getCurrentTimeIST() {
  // Current time in IST in 'YYYY-MM-DD HH:mm:ss' format
  const now = new Date();
  // Convert to IST
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const min = String(ist.getUTCMinutes()).padStart(2, '0');
  const ss = String(ist.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

// Helper to sleep for rate limiting
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper: Calculate fromDate based on last OHLC timestamp or fallback to 210 candles
function calculateFromDate(lastOHLCTimestamp: string, interval: string, holidays: string[] = []): string {
  if (!lastOHLCTimestamp || lastOHLCTimestamp === '1970-01-01') {
    // No previous data, fallback to 210 candles
    return getFromDateForNCandles(210, interval, holidays);
  }

  const lastTimestamp = new Date(lastOHLCTimestamp);
  const now = new Date();
  const timeDiffMs = now.getTime() - lastTimestamp.getTime();
  const timeDiffMinutes = timeDiffMs / (1000 * 60);

  // Calculate how many candles we need based on time difference
  const candlesPerDay = CANDLES_PER_DAY[interval];
  const minutesPerCandle = interval === "5" ? 5 : 60;
  const candlesNeeded = Math.ceil(timeDiffMinutes / minutesPerCandle);

  if (candlesNeeded > 210) {
    // Gap is too large, fallback to 210 candles
    console.log(`Large gap detected (${candlesNeeded} candles needed), using 210 candle fallback`);
    return getFromDateForNCandles(210, interval, holidays);
  }

  // Use the last timestamp as fromDate (add 1 minute to avoid overlap)
  const fromDate = new Date(lastTimestamp.getTime() + 60000); // Add 1 minute
  const istFromDate = new Date(fromDate.getTime() + 5.5 * 60 * 60 * 1000); // Convert to IST
  
  const yyyy = istFromDate.getUTCFullYear();
  const mm = String(istFromDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(istFromDate.getUTCDate()).padStart(2, '0');
  const hh = String(istFromDate.getUTCHours()).padStart(2, '0');
  const min = String(istFromDate.getUTCMinutes()).padStart(2, '0');
  const ss = String(istFromDate.getUTCSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

// Process a single stock with all its timeframes
async function processStock(stock: any, intervals: string[], nCandles: number, holidays: string[], lastProcessedTimestamp: string) {
  const results = [];
  
  // Skip stocks with missing required fields
  if (!stock.security_id || !stock.exchange_segment || !stock.instrument) {
    return { stock_id: stock.id, error: "Missing required fields" };
  }
  
  try {
    console.log(`Processing stock_id: ${stock.id}`);
    
    for (const interval of intervals) {
      try {
        // Get the last OHLC timestamp for this stock/timeframe
        const lastOHLCRes = await supabaseFetch(
          `ohlc_data?stock_id=eq.${stock.id}&timeframe=eq.${interval}&order=timestamp.desc&limit=1&select=timestamp`
        );
        
        let lastOHLCTimestamp = '1970-01-01';
        if (lastOHLCRes.ok) {
          const lastOHLCData = await lastOHLCRes.json();
          if (lastOHLCData.length > 0) {
            lastOHLCTimestamp = lastOHLCData[0].timestamp;
            console.log(`Last OHLC timestamp for ${stock.id}/${interval}: ${lastOHLCTimestamp}`);
          }
        }

        // Check if we need to fetch new data for this stock/timeframe
        // Get existing candles since last pipeline run
        const existingCandlesRes = await supabaseFetch(
          `ohlc_data?stock_id=eq.${stock.id}&timeframe=eq.${interval}&timestamp=gt.${encodeURIComponent(lastProcessedTimestamp)}&order=timestamp.desc&limit=1`
        );
        
        // If we have recent data since last pipeline run, skip fetching
        if (existingCandlesRes.ok) {
          const existingCandles = await existingCandlesRes.json();
          if (existingCandles.length > 0) {
            console.log(`Skipping ${stock.id}/${interval}: Data already exists since last pipeline run`);
            results.push({ interval, skipped: true, reason: "Data already exists since last pipeline run" });
            continue;
          }
        }
        
        console.log(`Fetching new data for ${stock.id}/${interval}`);
        
        // Calculate fromDate based on last OHLC timestamp or fallback to 210 candles
        const fromDate = calculateFromDate(lastOHLCTimestamp, interval, holidays);
        const toDate = getCurrentTimeIST();
        
        console.log(`Dhan API call for ${stock.id}/${interval}: fromDate=${fromDate}, toDate=${toDate}`);

        // Fetch candles from Dhan
        const candles = await fetchOHLC(
          stock.security_id,
          stock.exchange_segment,
          stock.instrument,
          interval,
          fromDate,
          toDate
        );

        if (!candles || candles.length === 0) {
          console.log(`No candles fetched for ${stock.id}/${interval}`);
          results.push({ interval, candles: 0, error: "No data from API" });
          continue;
        }

        // Transform candles to match database schema
        const transformedCandles = candles.map((candle: any) => ({
          stock_id: stock.id,
          timeframe: interval,
          timestamp: candle.timestamp,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume || 0,
        }));

        // Batch upsert candles (in chunks of 100)
        let totalCandles = 0;
        for (let i = 0; i < transformedCandles.length; i += 100) {
          const chunk = transformedCandles.slice(i, i + 100);
          const upsertRes = await supabaseFetch(
            "ohlc_data?on_conflict=stock_id,timeframe,timestamp",
            {
              method: "POST",
              body: JSON.stringify(chunk),
            }
          );
          
          if (!upsertRes.ok) {
            console.error(`Failed to upsert candles for ${stock.id}/${interval}: ${upsertRes.status}`);
            results.push({ interval, error: `Failed to upsert: ${upsertRes.status}` });
            break;
          } else {
            totalCandles += chunk.length;
          }
        }

        console.log(`Successfully processed ${totalCandles} candles for ${stock.id}/${interval}`);
        results.push({ interval, candles: totalCandles });

      } catch (intervalError: any) {
        console.error(`Error processing ${stock.id}/${interval}: ${intervalError.message}`);
        results.push({ interval, error: intervalError.message });
      }
    }

    return { stock_id: stock.id, results };

  } catch (stockError: any) {
    console.error(`Error processing stock ${stock.id}: ${stockError.message}`);
    return { stock_id: stock.id, error: stockError.message };
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    console.log("Starting fetch_ohlc with pipeline-based delta processing...");
    
    // Get the pipeline's last processed timestamp (single source of truth)
    const lastProcessedTimestamp = await getPipelineLastProcessedTimestamp();
    console.log(`Using pipeline's last processed timestamp: ${lastProcessedTimestamp}`);
    
    // 1. Fetch all active stocks with required fields
    const stocksRes = await supabaseFetch("stocks?select=id,security_id,exchange_segment,instrument,is_active&is_active=eq.true");
    if (!stocksRes.ok) throw new Error("Failed to fetch stocks");
    const stocks = await stocksRes.json();
    if (!Array.isArray(stocks) || stocks.length === 0) {
      return new Response(JSON.stringify({ error: "No active stocks found" }), { status: 404 });
    }

    console.log(`Processing ${stocks.length} active stocks in parallel`);

    // 2. For each stock, fetch OHLC data for the interval(s)
    const intervals: string[] = ["5", "60"]; // 5-min and 1hr intervals
    const nCandles = 210;
    let totalCandles = 0;
    let errors: any[] = [];
    let processedStocks = 0;
    // Optionally, add a list of holidays (YYYY-MM-DD)
    const holidays: string[] = [];

    // Process stocks in parallel batches to respect rate limits
    const batchSize = 5; // Process 5 stocks at a time (5 calls/second limit)
    const allResults = [];
    
    for (let i = 0; i < stocks.length; i += batchSize) {
      const batch = stocks.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(stocks.length/batchSize)}: ${batch.length} stocks`);
      
      // Process batch in parallel
      const batchPromises = batch.map(stock => processStock(stock, intervals, nCandles, holidays, lastProcessedTimestamp));
      const batchResults = await Promise.all(batchPromises);
      
      // Process results
      for (const result of batchResults) {
        if (result.error) {
          errors.push(result);
        } else {
          processedStocks++;
          // Count total candles
          for (const intervalResult of result.results) {
            if (intervalResult.candles) {
              totalCandles += intervalResult.candles;
            } else if (intervalResult.error) {
              errors.push(intervalResult);
            }
          }
        }
      }
      
      allResults.push(...batchResults);
      
      // Rate limit: Wait between batches (except for the last batch)
      if (i + batchSize < stocks.length) {
        console.log(`Waiting 1 second before next batch...`);
        await sleep(1000);
      }
    }

    console.log(`Function completed. Processed ${processedStocks} stocks, Total candles: ${totalCandles}, Errors: ${errors.length}`);

    return new Response(JSON.stringify({ success: true, totalCandles, processedStocks, errors, allResults }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  } catch (e) {
    console.error(`Function error: ${e.message}`);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }
});
