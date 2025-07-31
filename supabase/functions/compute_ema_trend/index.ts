/// <reference types="deno.ns" />
// Supabase Edge Function: Compute 9-30 EMA trend and crossover signals
// Deno runtime
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { 
  getStockTimeframePairs, 
  getCandlesSinceTimestamp,
  getPipelineLastProcessedTimestamp
} from "../shared/processing_state.ts";

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

// Process a single stock/timeframe pair
async function processStockTimeframe(pair: any, ema9Id: number, ema30Id: number, lastProcessedTimestamp: string) {
  const { stock_id, timeframe } = pair;
  
  try {
    console.log(`Processing stock_id: ${stock_id}, timeframe: ${timeframe}`);
    
    // Get new candles since last pipeline run for this stock/timeframe
    const allNewCandles = await getCandlesSinceTimestamp(lastProcessedTimestamp);
    const newCandles = allNewCandles.filter((candle: any) => 
      candle.stock_id === stock_id && candle.timeframe === timeframe
    );
    
    if (newCandles.length === 0) {
      console.log(`No new data for ${stock_id}/${timeframe}, skipping`);
      return { stock_id, timeframe, skipped: true };
    }
    
    console.log(`Found ${newCandles.length} new candles for ${stock_id}/${timeframe}`);

    // Get 9 EMA and 30 EMA signals for the new candles
    const timestamps = newCandles.map((d: any) => d.timestamp);
    const timestampFilter = timestamps.map((ts: string) => `timestamp.eq.${encodeURIComponent(ts)}`).join(",");
    
    // Get 9 EMA signals
    const ema9SignalsRes = await supabaseFetch(
      `signals?stock_id=eq.${stock_id}&indicator_id=eq.${ema9Id}&timeframe=eq.${timeframe}&or=(${timestampFilter})&order=timestamp.asc&select=timestamp,value`
    );
    if (!ema9SignalsRes.ok) {
      console.log(`Skipping ${stock_id}/${timeframe}: Failed to get 9 EMA signals`);
      return { stock_id, timeframe, error: "Failed to get 9 EMA signals" };
    }
    const ema9Signals = await ema9SignalsRes.json();

    // Get 30 EMA signals
    const ema30SignalsRes = await supabaseFetch(
      `signals?stock_id=eq.${stock_id}&indicator_id=eq.${ema30Id}&timeframe=eq.${timeframe}&or=(${timestampFilter})&order=timestamp.asc&select=timestamp,value`
    );
    if (!ema30SignalsRes.ok) {
      console.log(`Skipping ${stock_id}/${timeframe}: Failed to get 30 EMA signals`);
      return { stock_id, timeframe, error: "Failed to get 30 EMA signals" };
    }
    const ema30Signals = await ema30SignalsRes.json();

    console.log(`Found ${ema9Signals.length} 9 EMA signals and ${ema30Signals.length} 30 EMA signals for ${stock_id}/${timeframe}`);

    // Create maps for quick lookup
    const ema9Map = new Map(ema9Signals.map((s: any) => [s.timestamp, s.value]));
    const ema30Map = new Map(ema30Signals.map((s: any) => [s.timestamp, s.value]));

    // Get previous EMA values for crossover detection
    const firstTimestamp = timestamps[0];
    const prevEma9Res = await supabaseFetch(
      `signals?stock_id=eq.${stock_id}&indicator_id=eq.${ema9Id}&timeframe=eq.${timeframe}&timestamp=lt.${encodeURIComponent(firstTimestamp)}&order=timestamp.desc&limit=1&select=timestamp,value`
    );
    const prevEma30Res = await supabaseFetch(
      `signals?stock_id=eq.${stock_id}&indicator_id=eq.${ema30Id}&timeframe=eq.${timeframe}&timestamp=lt.${encodeURIComponent(firstTimestamp)}&order=timestamp.desc&limit=1&select=timestamp,value`
    );

    let prevEma9 = null;
    let prevEma30 = null;
    
    if (prevEma9Res.ok) {
      const prevEma9Data = await prevEma9Res.json();
      if (Array.isArray(prevEma9Data) && prevEma9Data.length > 0) {
        prevEma9 = prevEma9Data[0].value;
        console.log(`Found previous 9 EMA: ${prevEma9} at ${prevEma9Data[0].timestamp}`);
      }
    }
    
    if (prevEma30Res.ok) {
      const prevEma30Data = await prevEma30Res.json();
      if (Array.isArray(prevEma30Data) && prevEma30Data.length > 0) {
        prevEma30 = prevEma30Data[0].value;
        console.log(`Found previous 30 EMA: ${prevEma30} at ${prevEma30Data[0].timestamp}`);
      }
    }

    // Process each timestamp and compute trend data
    const trendData = [];
    
    // Sort new candles by timestamp to ensure proper sequential processing
    const sortedCandles = newCandles.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    for (const candle of sortedCandles) {
      const ema9 = ema9Map.get(candle.timestamp);
      const ema30 = ema30Map.get(candle.timestamp);
      
      if (ema9 === undefined || ema30 === undefined) {
        console.log(`Skipping timestamp ${candle.timestamp}: Missing EMA data (9: ${ema9}, 30: ${ema30})`);
        continue;
      }

      // Determine crossover
      let crossover = null;
      if (prevEma9 !== null && prevEma30 !== null) {
        // Check if this is a crossover event
        if (prevEma9 < prevEma30 && ema9 >= ema30) {
          crossover = 'Bullish';
          console.log(`Bullish crossover detected at ${candle.timestamp}: prev(9: ${prevEma9}, 30: ${prevEma30}) -> curr(9: ${ema9}, 30: ${ema30})`);
        } else if (prevEma9 > prevEma30 && ema9 <= ema30) {
          crossover = 'Bearish';
          console.log(`Bearish crossover detected at ${candle.timestamp}: prev(9: ${prevEma9}, 30: ${prevEma30}) -> curr(9: ${ema9}, 30: ${ema30})`);
        }
      }

      // Determine current trend
      const trend = ema9 >= ema30 ? 'Bullish' : 'Bearish';

      trendData.push({
        stock_id,
        timeframe,
        timestamp: candle.timestamp,
        ema_9: ema9,
        ema_30: ema30,
        trend,
        crossover,
      });

      // Update previous values for next iteration
      prevEma9 = ema9;
      prevEma30 = ema30;
    }

    // Batch upsert trend data (in chunks of 100)
    let totalTrends = 0;
    for (let i = 0; i < trendData.length; i += 100) {
      const chunk = trendData.slice(i, i + 100);
      const upsertRes = await supabaseFetch(
        "9_30_ema_trend?on_conflict=stock_id,timeframe,timestamp",
        {
          method: "POST",
          body: JSON.stringify(chunk),
        }
      );
      
      if (!upsertRes.ok) {
        console.error(`Failed to upsert trend data for ${stock_id}/${timeframe}: ${upsertRes.status}`);
        return { stock_id, timeframe, error: "Failed to upsert trend data" };
      } else {
        totalTrends += chunk.length;
      }
    }

    console.log(`Processed ${totalTrends} trend records for ${stock_id}/${timeframe}`);
    return { stock_id, timeframe, totalTrends };

  } catch (pairError: any) {
    console.error(`Error processing ${stock_id}/${timeframe}: ${pairError.message}`);
    return { stock_id, timeframe, error: pairError.message };
  }
}

serve(async (_req) => {
  try {
    console.log("Starting compute_ema_trend with pipeline-based delta processing...");
    
    // Get the pipeline's last processed timestamp (single source of truth)
    const lastProcessedTimestamp = await getPipelineLastProcessedTimestamp();
    console.log(`Using pipeline's last processed timestamp: ${lastProcessedTimestamp}`);
    
    // 1. Get 9 EMA and 30 EMA indicator IDs
    const indicatorsRes = await supabaseFetch(
      `indicators?select=id,params&type=eq.ema&or=(params->>period.eq.9,params->>period.eq.30)`
    );
    if (!indicatorsRes.ok) throw new Error("Failed to fetch indicators");
    const indicators = await indicatorsRes.json();
    
    if (!Array.isArray(indicators) || indicators.length < 2) {
      return new Response(JSON.stringify({ error: "9 EMA and 30 EMA indicators not found" }), { status: 404 });
    }

    // Find 9 EMA and 30 EMA indicators
    let ema9Id = null;
    let ema30Id = null;
    
    for (const indicator of indicators) {
      const period = parseInt(indicator.params?.period || indicator.params?.["period"] || "0", 10);
      if (period === 9) ema9Id = indicator.id;
      if (period === 30) ema30Id = indicator.id;
    }

    if (!ema9Id || !ema30Id) {
      return new Response(JSON.stringify({ error: "9 EMA or 30 EMA indicator not found" }), { status: 404 });
    }

    console.log(`Found 9 EMA indicator ID: ${ema9Id}, 30 EMA indicator ID: ${ema30Id}`);

    // 2. Get all (stock_id, timeframe) pairs
    const pairs = await getStockTimeframePairs();
    if (pairs.length === 0) {
      return new Response(JSON.stringify({ error: "No ohlc_data pairs found" }), { status: 404 });
    }

    console.log(`Processing ${pairs.length} stock/timeframe pairs in parallel`);

    let totalTrends = 0;
    let errors: any[] = [];
    let processedPairs = 0;
    let skippedPairs = 0;

    // Process pairs in parallel batches
    const batchSize = 10; // Process 10 pairs at a time
    const allResults = [];
    
    for (let i = 0; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(pairs.length/batchSize)}: ${batch.length} pairs`);
      
      // Process batch in parallel
      const batchPromises = batch.map(pair => processStockTimeframe(pair, ema9Id, ema30Id, lastProcessedTimestamp));
      const batchResults = await Promise.all(batchPromises);
      
      // Process results
      for (const result of batchResults) {
        if (result.error) {
          errors.push(result);
        } else if (result.skipped) {
          skippedPairs++;
        } else {
          processedPairs++;
          totalTrends += result.totalTrends || 0;
        }
      }
      
      allResults.push(...batchResults);
    }

    console.log(`Function completed. Processed ${processedPairs} pairs, Skipped ${skippedPairs} pairs, Total trends: ${totalTrends}, Errors: ${errors.length}`);
    
    return new Response(JSON.stringify({ success: true, totalTrends, processedPairs, skippedPairs, errors, allResults }), {
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