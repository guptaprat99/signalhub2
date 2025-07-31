/// <reference types="deno.ns" />
// Supabase Edge Function: Compute EMA signals and store in Supabase (Delta Processing + Parallel)
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

// Compute the EMA for a given list of candle closes (TradingView style)
function computeEMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const alpha = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] * alpha) + (ema * (1 - alpha));
  }
  return parseFloat(ema.toFixed(6));
}

// Process a single stock/timeframe pair with all indicators
async function processStockTimeframe(pair: any, emaIndicators: any[], lastProcessedTimestamp: string) {
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

    let totalSignals = 0;
    const errors = [];

    // Process each indicator for this stock/timeframe
    for (const indicator of emaIndicators) {
      try {
        // Get existing signals for this indicator to avoid duplicates
        const existingSignalsRes = await supabaseFetch(
          `signals?stock_id=eq.${stock_id}&indicator_id=eq.${indicator.id}&timeframe=eq.${timeframe}&select=timestamp`
        );
        let existingTimestamps = new Set<string>();
        if (existingSignalsRes.ok) {
          const existingSignals = await existingSignalsRes.json();
          if (Array.isArray(existingSignals)) {
            existingTimestamps = new Set(existingSignals.map((s: any) => s.timestamp));
          }
        }

        // Prepare new signals to insert
        const newSignals = [];
        const closes = newCandles.map((c: any) => c.close);
        const timestamps = newCandles.map((c: any) => c.timestamp);

        for (let i = indicator.period - 1; i < newCandles.length; i++) {
          if (!existingTimestamps.has(timestamps[i])) {
            // Compute EMA for closes[0..i] (TradingView style)
            const closesSlice = closes.slice(0, i + 1);
            const emaValue = computeEMA(closesSlice, indicator.period);
            if (emaValue !== null) {
              newSignals.push({
                stock_id,
                indicator_id: indicator.id,
                timeframe,
                timestamp: timestamps[i],
                value: emaValue,
              });
            }
          }
        }

        // Batch upsert newSignals (in chunks of 100)
        for (let i = 0; i < newSignals.length; i += 100) {
          const chunk = newSignals.slice(i, i + 100);
          const upsertRes = await supabaseFetch(
            "signals?on_conflict=stock_id,indicator_id,timeframe,timestamp",
            {
              method: "POST",
              body: JSON.stringify(chunk),
            }
          );
          
          if (!upsertRes.ok) {
            console.error(`Failed to upsert signals for indicator ${indicator.id}: ${upsertRes.status}`);
            errors.push(`Failed to upsert signals for indicator ${indicator.id}`);
          } else {
            totalSignals += chunk.length;
          }
        }
        
        console.log(`Processed ${newSignals.length} signals for indicator ${indicator.id} (${stock_id}/${timeframe})`);
        
      } catch (indicatorError: any) {
        console.error(`Error processing indicator ${indicator.id} for ${stock_id}/${timeframe}: ${indicatorError.message}`);
        errors.push(`Indicator ${indicator.id}: ${indicatorError.message}`);
      }
    }

    return { 
      stock_id, 
      timeframe, 
      totalSignals, 
      errors: errors.length > 0 ? errors : undefined 
    };

  } catch (pairError: any) {
    console.error(`Error processing ${stock_id}/${timeframe}: ${pairError.message}`);
    return { stock_id, timeframe, error: pairError.message };
  }
}

serve(async (_req) => {
  try {
    console.log("Starting compute_signals with pipeline-based delta processing...");
    
    // Get the pipeline's last processed timestamp (single source of truth)
    const lastProcessedTimestamp = await getPipelineLastProcessedTimestamp();
    console.log(`Using pipeline's last processed timestamp: ${lastProcessedTimestamp}`);
    
    // 1. Fetch all active EMA indicators
    const indicatorsRes = await supabaseFetch(
      `indicators?select=id,type,params,is_active&is_active=eq.true&type=eq.ema`
    );
    if (!indicatorsRes.ok) throw new Error("Failed to fetch indicators");
    const indicators = await indicatorsRes.json();
    if (!Array.isArray(indicators) || indicators.length === 0) {
      return new Response(JSON.stringify({ error: "No active EMA indicators found" }), { status: 404 });
    }

    // 2. For each indicator, get period from params
    const emaIndicators = indicators.map((ind: any) => ({
      id: ind.id,
      period: parseInt(ind.params?.period || ind.params?.["period"] || "0", 10),
    })).filter((ind: any) => ind.period > 0);
    if (emaIndicators.length === 0) {
      return new Response(JSON.stringify({ error: "No valid EMA indicators found" }), { status: 404 });
    }

    console.log(`Found ${emaIndicators.length} EMA indicators to process`);

    // 3. Get all (stock_id, timeframe) pairs
    const pairs = await getStockTimeframePairs();
    if (pairs.length === 0) {
      return new Response(JSON.stringify({ error: "No ohlc_data pairs found" }), { status: 404 });
    }

    console.log(`Processing ${pairs.length} stock/timeframe pairs in parallel`);

    let totalSignals = 0;
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
      const batchPromises = batch.map(pair => processStockTimeframe(pair, emaIndicators, lastProcessedTimestamp));
      const batchResults = await Promise.all(batchPromises);
      
      // Process results
      for (const result of batchResults) {
        if (result.error) {
          errors.push(result);
        } else if (result.skipped) {
          skippedPairs++;
        } else {
          processedPairs++;
          totalSignals += result.totalSignals || 0;
          if (result.errors) {
            errors.push(...result.errors);
          }
        }
      }
      
      allResults.push(...batchResults);
    }

    console.log(`Function completed. Processed ${processedPairs} pairs, Skipped ${skippedPairs} pairs, Total signals: ${totalSignals}, Errors: ${errors.length}`);
    
    return new Response(JSON.stringify({ success: true, totalSignals, processedPairs, skippedPairs, errors, allResults }), {
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