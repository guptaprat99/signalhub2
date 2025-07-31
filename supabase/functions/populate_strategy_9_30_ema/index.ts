/// <reference types="deno.ns" />
// Supabase Edge Function: Populate 9-30 EMA strategy table
// Deno runtime
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getPipelineLastProcessedTimestamp } from "../shared/processing_state.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Helper: Supabase fetch with auth headers
function supabaseFetch(path: string, options: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
  });
}

serve(async (_req) => {
  try {
    console.log("Starting populate_9_30_ema_strategy with pipeline-based delta processing...");
    
    // Get the pipeline's last processed timestamp (single source of truth)
    const lastProcessedTimestamp = await getPipelineLastProcessedTimestamp();
    console.log(`Using pipeline's last processed timestamp: ${lastProcessedTimestamp}`);
    
    // 1. Get latest CMP (today's close) per symbol since last pipeline run
    console.log("Fetching latest prices per symbol since last pipeline run...");
    const latestPricesRes = await supabaseFetch(
      `ohlc_data?select=stock_id,timestamp,close&timestamp=gt.${encodeURIComponent(lastProcessedTimestamp)}&order=timestamp.desc`
    );
    if (!latestPricesRes.ok) throw new Error("Failed to fetch latest prices");
    const allLatestPrices = await latestPricesRes.json();
    
    if (allLatestPrices.length === 0) {
      console.log("No new OHLC data since last pipeline run, skipping strategy population");
      return new Response(JSON.stringify({ success: true, message: "No new data to process" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        },
      });
    }
    
    // Group by stock_id and get the latest for each
    const latestPricesMap = new Map();
    for (const price of allLatestPrices) {
      if (!latestPricesMap.has(price.stock_id)) {
        latestPricesMap.set(price.stock_id, price);
      }
    }
    
    // Get stock symbols for the latest prices
    const stockIds = Array.from(latestPricesMap.keys());
    const stockIdsFilter = stockIds.map(id => `id.eq.${id}`).join(",");
    const stocksRes = await supabaseFetch(
      `stocks?or=(${stockIdsFilter})&select=id,symbol`
    );
    if (!stocksRes.ok) throw new Error("Failed to fetch stock symbols");
    const stocks = await stocksRes.json();
    const stockMap = new Map(stocks.map((s: any) => [s.id, s.symbol]));
    
    // 2. Get latest close *before today* (for % change calc)
    console.log("Fetching previous day closes...");
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    const previousDayRes = await supabaseFetch(
      `ohlc_data?select=stock_id,timestamp,close&timestamp=lt.${today}T00:00:00&order=timestamp.desc`
    );
    if (!previousDayRes.ok) throw new Error("Failed to fetch previous day closes");
    const allPreviousDayPrices = await previousDayRes.json();
    
    console.log(`Found ${allPreviousDayPrices.length} previous day price records`);
    
    // Group by stock_id and get the latest before today for each
    const previousDayMap = new Map();
    for (const price of allPreviousDayPrices) {
      if (!previousDayMap.has(price.stock_id)) {
        previousDayMap.set(price.stock_id, price);
      }
    }
    
    console.log(`Found previous day closes for ${previousDayMap.size} stocks`);
    
    // 3. Latest trend per symbol per timeframe since last pipeline run
    console.log("Fetching latest trends since last pipeline run...");
    const trendsRes = await supabaseFetch(
      `9_30_ema_trend?select=stock_id,timeframe,trend,timestamp&timestamp=gt.${encodeURIComponent(lastProcessedTimestamp)}&order=timestamp.desc`
    );
    if (!trendsRes.ok) throw new Error("Failed to fetch trends");
    const allTrends = await trendsRes.json();
    
    // Group by stock_id and timeframe, get latest for each
    const trendsMap = new Map();
    for (const trend of allTrends) {
      const key = `${trend.stock_id}|${trend.timeframe}`;
      if (!trendsMap.has(key)) {
        trendsMap.set(key, trend);
      }
    }
    
    // 4. Latest crossover per symbol per timeframe since last pipeline run
    console.log("Fetching crossovers since last pipeline run...");
    const crossoversRes = await supabaseFetch(
      `9_30_ema_trend?select=stock_id,timeframe,timestamp,crossover,stocks(symbol)&crossover.not.is.null&timestamp=gt.${encodeURIComponent(lastProcessedTimestamp)}&order=timestamp.desc`
    );
    if (!crossoversRes.ok) throw new Error("Failed to fetch crossovers");
    const allCrossovers = await crossoversRes.json();

    console.log(`Found ${allCrossovers.length} new crossovers since last pipeline run`);

    // Group by symbol + timeframe, and take latest per group (matching SQL DISTINCT ON logic)
    const crossoversMap = new Map();
    for (const row of allCrossovers) {
      // Only process records that actually have crossover values
      if (row.crossover && row.crossover !== null) {
        const key = `${row.stocks.symbol}|${row.timeframe}`;
        if (!crossoversMap.has(key)) {
          crossoversMap.set(key, row); // already sorted desc by timestamp
        }
      }
    }
    
    // 5. Build the final data for strategy_9_30_ema table
    console.log("Building strategy data...");
    const strategyData = [];
    
    for (const [stockId, latestPrice] of latestPricesMap) {
      const symbol = stockMap.get(stockId);
      if (!symbol) {
        console.log(`Skipping stock_id ${stockId}: symbol not found`);
        continue;
      }
      
      const cmp = latestPrice.close;
      const cmpTimestamp = latestPrice.timestamp;
      
      // Get previous day close for percentage change calculation
      const prevDayPrice = previousDayMap.get(stockId);
      let prevClose = null;
      let prcntChange = null;
      
      if (prevDayPrice) {
        prevClose = prevDayPrice.close;
        // Calculate percentage change with full precision, then round to 2 decimals (matching SQL logic)
        const rawPercentage = ((cmp - prevClose) / prevClose) * 100;
        prcntChange = Math.round(rawPercentage * 100) / 100; // Round to 2 decimal places
        console.log(`${symbol}: CMP=${cmp}, Prev=${prevClose}, Change=${prcntChange}%`);
      } else {
        console.log(`${symbol}: No previous day data found`);
      }
      
      // Get trends for 5min and 60min timeframes
      const trend5min = trendsMap.get(`${stockId}|5`)?.trend || null;
      const trend60min = trendsMap.get(`${stockId}|60`)?.trend || null;
      
      // Get crossovers for 5min and 60min timeframes (using symbol as key)
      const crossover5min = crossoversMap.get(`${symbol}|5`)?.timestamp || null;
      const crossover60min = crossoversMap.get(`${symbol}|60`)?.timestamp || null;
      
      strategyData.push({
        stock_id: stockId,
        symbol,
        cmp,
        prcnt_change: prcntChange,
        cmp_timestamp: cmpTimestamp,
        trend_5min: trend5min,
        crossover_5min: crossover5min,
        trend_60min: trend60min,
        crossover_60min: crossover60min,
        last_updated: new Date().toISOString()
      });
    }
    
    console.log(`Generated ${strategyData.length} strategy records`);
    
    // Sort the data by crossover_5min desc (matching SQL order by)
    strategyData.sort((a: any, b: any) => {
      if (!a.crossover_5min && !b.crossover_5min) return 0;
      if (!a.crossover_5min) return 1; // null values go to the end
      if (!b.crossover_5min) return -1;
      return new Date(b.crossover_5min).getTime() - new Date(a.crossover_5min).getTime();
    });
    
    // 6. Clear existing data and insert new data
    console.log("Clearing existing strategy data...");
    const clearRes = await supabaseFetch(
      `strategy_9_30_ema`,
      { method: "DELETE" }
    );
    if (!clearRes.ok) {
      console.warn(`Warning: Failed to clear existing data: ${clearRes.status}`);
    }
    
    // 7. Insert new data in batches
    console.log("Inserting new strategy data...");
    let insertedCount = 0;
    const batchSize = 100;
    
    for (let i = 0; i < strategyData.length; i += batchSize) {
      const batch = strategyData.slice(i, i + batchSize);
      const insertRes = await supabaseFetch(
        `strategy_9_30_ema`,
        {
          method: "POST",
          body: JSON.stringify(batch),
        }
      );
      
      if (!insertRes.ok) {
        const errorText = await insertRes.text();
        console.error(`Failed to insert batch ${Math.floor(i/batchSize) + 1}: ${errorText}`);
        throw new Error(`Failed to insert strategy data: ${errorText}`);
      }
      
      insertedCount += batch.length;
      console.log(`Inserted batch ${Math.floor(i/batchSize) + 1}: ${batch.length} records`);
    }
    
    console.log(`Function completed successfully. Total records inserted: ${insertedCount}`);
    
    return new Response(JSON.stringify({ 
      success: true, 
      totalRecords: insertedCount,
      message: `Successfully populated 9-30 EMA strategy table with ${insertedCount} records`
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
    
  } catch (e: any) {
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