/// <reference types="deno.ns" />
// Supabase Edge Function: Compute EMA signals and store in Supabase
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

serve(async (_req) => {
  try {
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

    // 3. Get all (stock_id, timeframe) pairs from ohlc_data (deduplicate in JS)
    const pairsRes = await supabaseFetch(
      `ohlc_data?select=stock_id,timeframe`
    );
    if (!pairsRes.ok) throw new Error("Failed to fetch ohlc_data pairs");
    const allPairs = await pairsRes.json();
    if (!Array.isArray(allPairs) || allPairs.length === 0) {
      return new Response(JSON.stringify({ error: "No ohlc_data pairs found" }), { status: 404 });
    }
    // Deduplicate pairs
    const seen = new Set();
    const pairs = allPairs.filter((p: any) => {
      const key = `${p.stock_id}|${p.timeframe}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (pairs.length === 0) {
      return new Response(JSON.stringify({ error: "No ohlc_data pairs found" }), { status: 404 });
    }

    let totalSignals = 0;
    let errors: any[] = [];

    for (const pair of pairs) {
      const { stock_id, timeframe } = pair;
      // Fetch all candles for this pair, ordered by timestamp ASC
      const candlesRes = await supabaseFetch(
        `ohlc_data?stock_id=eq.${stock_id}&timeframe=eq.${timeframe}&order=timestamp.asc&select=timestamp,close`
      );
      if (!candlesRes.ok) continue;
      const candles = await candlesRes.json();
      if (!Array.isArray(candles) || candles.length === 0) continue;
      const closes = candles.map((c: any) => c.close);
      const timestamps = candles.map((c: any) => c.timestamp);

      for (const indicator of emaIndicators) {
        // Fetch all existing signals for this combo
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
        for (let i = indicator.period - 1; i < candles.length; i++) {
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
            `signals?on_conflict=stock_id,indicator_id,timeframe,timestamp`,
            {
              method: "POST",
              body: JSON.stringify(chunk),
            }
          );
          if (!upsertRes.ok) {
            const err = await upsertRes.text();
            errors.push({ stock_id, indicator_id: indicator.id, timeframe, error: err });
          } else {
            totalSignals += chunk.length;
          }
        }
        // Prune old signals (keep only latest 50)
        const signalsRes = await supabaseFetch(
          `signals?stock_id=eq.${stock_id}&indicator_id=eq.${indicator.id}&timeframe=eq.${timeframe}&select=timestamp&order=timestamp.desc`
        );
        if (signalsRes.ok) {
          const allSignals = await signalsRes.json();
          if (Array.isArray(allSignals) && allSignals.length > 50) {
            const timestampsToDelete = allSignals.slice(50).map((r: any) => r.timestamp);
            for (let i = 0; i < timestampsToDelete.length; i += 100) {
              const chunk = timestampsToDelete.slice(i, i + 100);
              const orClause = chunk.map((ts: string) => `timestamp.eq.${encodeURIComponent(ts)}`).join(",");
              await supabaseFetch(
                `signals?stock_id=eq.${stock_id}&indicator_id=eq.${indicator.id}&timeframe=eq.${timeframe}&or=(${orClause})`,
                { method: "DELETE" }
              );
            }
          }
        }
      }
    }

    return new Response(JSON.stringify({ success: true, totalSignals, errors }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  } catch (e) {
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