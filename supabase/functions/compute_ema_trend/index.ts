/// <reference types="deno.ns" />
// Supabase Edge Function: Compute 9-30 EMA trend and store in 9_30_ema_trend table
// Deno runtime
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
    console.log("Starting compute_ema_trend function...");
    
    // 1. Get all (stock_id, timeframe) pairs from ohlc_data
    const pairsRes = await supabaseFetch(
      `ohlc_data?select=stock_id,timeframe`
    );
    if (!pairsRes.ok) throw new Error("Failed to fetch ohlc_data pairs");
    const allPairs = await pairsRes.json();
    if (!Array.isArray(allPairs) || allPairs.length === 0) {
      return new Response(JSON.stringify({ error: "No ohlc_data pairs found" }), { status: 404 });
    }
    
    console.log(`Found ${allPairs.length} total pairs in ohlc_data`);
    
    // Deduplicate pairs
    const seen = new Set();
    const pairs = allPairs.filter((p: any) => {
      const key = `${p.stock_id}|${p.timeframe}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`Processing ${pairs.length} unique stock/timeframe pairs`);

    let totalTrends = 0;
    let errors: any[] = [];

    // 2. Check if indicators exist first
    console.log("Checking for 9 EMA and 30 EMA indicators...");
    const ema9Res = await supabaseFetch(`indicators?name=eq.9 EMA&select=id,name`);
    const ema30Res = await supabaseFetch(`indicators?name=eq.30 EMA&select=id,name`);
    
    if (!ema9Res.ok || !ema30Res.ok) {
      const error = `Failed to fetch indicators: 9 EMA (${ema9Res.ok}), 30 EMA (${ema30Res.ok})`;
      console.error(error);
      return new Response(JSON.stringify({ error }), { status: 500 });
    }
    
    const ema9Indicator = await ema9Res.json();
    const ema30Indicator = await ema30Res.json();
    
    if (!Array.isArray(ema9Indicator) || ema9Indicator.length === 0) {
      const error = "9 EMA indicator not found";
      console.error(error);
      return new Response(JSON.stringify({ error }), { status: 404 });
    }
    
    if (!Array.isArray(ema30Indicator) || ema30Indicator.length === 0) {
      const error = "30 EMA indicator not found";
      console.error(error);
      return new Response(JSON.stringify({ error }), { status: 404 });
    }
    
    const ema9Id = ema9Indicator[0].id;
    const ema30Id = ema30Indicator[0].id;
    
    console.log(`Found indicators: 9 EMA (${ema9Id}), 30 EMA (${ema30Id})`);

    for (const pair of pairs) {
      const { stock_id, timeframe } = pair;
      
      try {
        console.log(`Processing stock_id: ${stock_id}, timeframe: ${timeframe}`);
        
        // 3. Get the latest timestamp from ohlc_data for this stock/timeframe
        const latestOHLCRes = await supabaseFetch(
          `ohlc_data?stock_id=eq.${stock_id}&timeframe=eq.${timeframe}&order=timestamp.desc&limit=1&select=timestamp`
        );
        if (!latestOHLCRes.ok) {
          console.log(`Skipping ${stock_id}/${timeframe}: Failed to get latest OHLC timestamp`);
          continue;
        }
        const latestOHLC = await latestOHLCRes.json();
        if (!Array.isArray(latestOHLC) || latestOHLC.length === 0) {
          console.log(`Skipping ${stock_id}/${timeframe}: No OHLC data found`);
          continue;
        }
        const latestTimestamp = latestOHLC[0].timestamp;

        // 4. Get the latest timestamp from 9_30_ema_trend for this stock/timeframe
        const latestTrendRes = await supabaseFetch(
          `9_30_ema_trend?stock_id=eq.${stock_id}&timeframe=eq.${timeframe}&order=timestamp.desc&limit=1&select=timestamp`
        );
        let lastProcessedTimestamp = null;
        if (latestTrendRes.ok) {
          const latestTrend = await latestTrendRes.json();
          if (Array.isArray(latestTrend) && latestTrend.length > 0) {
            lastProcessedTimestamp = latestTrend[0].timestamp;
            console.log(`Last processed timestamp for ${stock_id}/${timeframe}: ${lastProcessedTimestamp}`);
          }
        }

        // 5. Get OHLC data from the last processed timestamp onwards
        let ohlcQuery = `ohlc_data?stock_id=eq.${stock_id}&timeframe=eq.${timeframe}&order=timestamp.asc&select=timestamp,open,high,low,close,volume`;
        if (lastProcessedTimestamp) {
          ohlcQuery += `&timestamp=gt.${encodeURIComponent(lastProcessedTimestamp)}`;
        }
        
        const ohlcRes = await supabaseFetch(ohlcQuery);
        if (!ohlcRes.ok) {
          console.log(`Skipping ${stock_id}/${timeframe}: Failed to get OHLC data`);
          continue;
        }
        const ohlcData = await ohlcRes.json();
        if (!Array.isArray(ohlcData) || ohlcData.length === 0) {
          console.log(`Skipping ${stock_id}/${timeframe}: No new OHLC data to process`);
          continue;
        }

        console.log(`Found ${ohlcData.length} new OHLC records for ${stock_id}/${timeframe}`);

        // 6. Get 9 EMA and 30 EMA signals for the same time range
        const timestamps = ohlcData.map((d: any) => d.timestamp);
        const timestampFilter = timestamps.map((ts: string) => `timestamp.eq.${encodeURIComponent(ts)}`).join(",");
        
        // Get 9 EMA signals
        const ema9SignalsRes = await supabaseFetch(
          `signals?stock_id=eq.${stock_id}&indicator_id=eq.${ema9Id}&timeframe=eq.${timeframe}&or=(${timestampFilter})&order=timestamp.asc&select=timestamp,value`
        );
        if (!ema9SignalsRes.ok) {
          console.log(`Skipping ${stock_id}/${timeframe}: Failed to get 9 EMA signals`);
          continue;
        }
        const ema9Signals = await ema9SignalsRes.json();

        // Get 30 EMA signals
        const ema30SignalsRes = await supabaseFetch(
          `signals?stock_id=eq.${stock_id}&indicator_id=eq.${ema30Id}&timeframe=eq.${timeframe}&or=(${timestampFilter})&order=timestamp.asc&select=timestamp,value`
        );
        if (!ema30SignalsRes.ok) {
          console.log(`Skipping ${stock_id}/${timeframe}: Failed to get 30 EMA signals`);
          continue;
        }
        const ema30Signals = await ema30SignalsRes.json();

        console.log(`Found ${ema9Signals.length} 9 EMA signals and ${ema30Signals.length} 30 EMA signals for ${stock_id}/${timeframe}`);

        // 7. Create maps for quick lookup
        const ema9Map = new Map(ema9Signals.map((s: any) => [s.timestamp, s.value]));
        const ema30Map = new Map(ema30Signals.map((s: any) => [s.timestamp, s.value]));

        // 8. Get previous EMA values for crossover detection
        // Get the signal that comes before the first timestamp in our current batch
        const firstTimestamp = timestamps[0];
        const prevEma9Res = await supabaseFetch(
          `signals?stock_id=eq.${stock_id}&indicator_id=eq.${ema9Id}&timeframe=eq.${timeframe}&timestamp=lt.${encodeURIComponent(firstTimestamp)}&order=timestamp.desc&limit=1&select=timestamp,value`
        );
        const prevEma30Res = await supabaseFetch(
          `signals?stock_id=eq.${stock_id}&indicator_id=eq.${ema30Id}&timeframe=eq.${timeframe}&timestamp=lt.${encodeURIComponent(firstTimestamp)}&order=timestamp.desc&limit=1&select=timestamp,value`
        );

        let prevEma9 = null;
        let prevEma30 = null;
        let prevEma9Timestamp = null;
        let prevEma30Timestamp = null;
        
        if (prevEma9Res.ok) {
          const prevEma9Data = await prevEma9Res.json();
          if (Array.isArray(prevEma9Data) && prevEma9Data.length > 0) {
            prevEma9 = prevEma9Data[0].value;
            prevEma9Timestamp = prevEma9Data[0].timestamp;
            console.log(`Found previous 9 EMA: ${prevEma9} at ${prevEma9Timestamp}`);
          }
        }
        
        if (prevEma30Res.ok) {
          const prevEma30Data = await prevEma30Res.json();
          if (Array.isArray(prevEma30Data) && prevEma30Data.length > 0) {
            prevEma30 = prevEma30Data[0].value;
            prevEma30Timestamp = prevEma30Data[0].timestamp;
            console.log(`Found previous 30 EMA: ${prevEma30} at ${prevEma30Timestamp}`);
          }
        }

        // If we don't have previous values, we can't detect crossovers for the first record
        // but we can still calculate trends
        if (prevEma9 === null || prevEma30 === null) {
          console.log(`No previous EMA values found for ${stock_id}/${timeframe}, will skip crossover detection for first record`);
        }

        // 9. Process each timestamp and compute trend data
        const trendData = [];
        
        // Sort OHLC data by timestamp to ensure proper sequential processing
        const sortedOHLC = ohlcData.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        
        for (const ohlc of sortedOHLC) {
          const ema9 = ema9Map.get(ohlc.timestamp);
          const ema30 = ema30Map.get(ohlc.timestamp);
          
          if (ema9 === undefined || ema30 === undefined) {
            console.log(`Skipping timestamp ${ohlc.timestamp}: Missing EMA data (9: ${ema9}, 30: ${ema30})`);
            continue;
          }

          // Determine crossover
          let crossover = null;
          if (prevEma9 !== null && prevEma30 !== null) {
            // Check if this is a crossover event
            if (prevEma9 < prevEma30 && ema9 >= ema30) {
              crossover = 'Bullish';
              console.log(`Bullish crossover detected at ${ohlc.timestamp}: prev(9: ${prevEma9}, 30: ${prevEma30}) -> curr(9: ${ema9}, 30: ${ema30})`);
            } else if (prevEma9 > prevEma30 && ema9 <= ema30) {
              crossover = 'Bearish';
              console.log(`Bearish crossover detected at ${ohlc.timestamp}: prev(9: ${prevEma9}, 30: ${prevEma30}) -> curr(9: ${ema9}, 30: ${ema30})`);
            }
          }

          // Determine current trend
          const trend = ema9 >= ema30 ? 'Bullish' : 'Bearish';

          trendData.push({
            stock_id,
            timeframe,
            timestamp: ohlc.timestamp,
            ema_9: ema9,
            ema_30: ema30,
            trend,
            crossover
          });

          // Update previous values for next iteration
          prevEma9 = ema9;
          prevEma30 = ema30;
        }

        console.log(`Generated ${trendData.length} trend records for ${stock_id}/${timeframe}`);

        // 10. Batch upsert trend data
        for (let i = 0; i < trendData.length; i += 100) {
          const chunk = trendData.slice(i, i + 100);
          const upsertRes = await supabaseFetch(
            `9_30_ema_trend?on_conflict=stock_id,timeframe,timestamp`,
            {
              method: "POST",
              body: JSON.stringify(chunk),
            }
          );
          if (!upsertRes.ok) {
            const err = await upsertRes.text();
            console.error(`Failed to upsert trend data for ${stock_id}/${timeframe}: ${err}`);
            errors.push({ stock_id, timeframe, error: err });
          } else {
            totalTrends += chunk.length;
            console.log(`Successfully upserted ${chunk.length} trend records for ${stock_id}/${timeframe}`);
          }
        }

        // 11. Prune old trend data (keep only latest 50)
        const trendsRes = await supabaseFetch(
          `9_30_ema_trend?stock_id=eq.${stock_id}&timeframe=eq.${timeframe}&select=timestamp&order=timestamp.desc`
        );
        if (trendsRes.ok) {
          const allTrends = await trendsRes.json();
          if (Array.isArray(allTrends) && allTrends.length > 50) {
            const timestampsToDelete = allTrends.slice(50).map((r: any) => r.timestamp);
            for (let i = 0; i < timestampsToDelete.length; i += 100) {
              const chunk = timestampsToDelete.slice(i, i + 100);
              const orClause = chunk.map((ts: string) => `timestamp.eq.${encodeURIComponent(ts)}`).join(",");
              await supabaseFetch(
                `9_30_ema_trend?stock_id=eq.${stock_id}&timeframe=eq.${timeframe}&or=(${orClause})`,
                { method: "DELETE" }
              );
            }
          }
        }

      } catch (pairError: any) {
        console.error(`Error processing ${pair.stock_id}/${pair.timeframe}: ${pairError.message}`);
        errors.push({ stock_id: pair.stock_id, timeframe: pair.timeframe, error: pairError.message });
      }
    }

    console.log(`Function completed. Total trends processed: ${totalTrends}, Errors: ${errors.length}`);
    
    return new Response(JSON.stringify({ success: true, totalTrends, errors }), {
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