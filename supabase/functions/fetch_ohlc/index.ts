/// <reference types="deno.ns" />
// Supabase Edge Function: Fetch OHLC data from Dhan and store in Supabase
// Deno runtime
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { fetchOHLC } from "../../../utils/fetchOHLC.ts";

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

serve(async (_req) => {
  try {
    // 1. Fetch all active stocks with required fields
    const stocksRes = await supabaseFetch("stocks?select=id,security_id,exchange_segment,instrument,is_active&is_active=eq.true");
    if (!stocksRes.ok) throw new Error("Failed to fetch stocks");
    const stocks = await stocksRes.json();
    if (!Array.isArray(stocks) || stocks.length === 0) {
      return new Response(JSON.stringify({ error: "No active stocks found" }), { status: 404 });
    }

    // 2. For each stock, fetch OHLC data for the interval(s)
    const intervals: string[] = ["5"]; // Only 5-min for now, support more later
    let totalCandles = 0;
    let errors: any[] = [];

    // Helper to sleep for rate limiting
    function sleep(ms: number) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Date helpers: last 5 days
    function getDateString(offsetDays: number) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - offsetDays);
      return d.toISOString().slice(0, 10); // YYYY-MM-DD
    }
    const fromDate = getDateString(5);
    const toDate = getDateString(0);

    for (const stock of stocks) {
      // Skip stocks with missing required fields
      if (!stock.security_id || !stock.exchange_segment || !stock.instrument) continue;
      for (const interval of intervals) {
        try {
          // Fetch candles from Dhan
          const candles = await fetchOHLC({
            dhanToken: DHAN_API_TOKEN,
            securityId: stock.security_id,
            exchangeSegment: stock.exchange_segment,
            instrument: stock.instrument,
            interval,
            fromDate,
            toDate,
          });

          if (!Array.isArray(candles) || candles.length === 0) continue;

          // Prepare data for upsert
          const rows = candles.map((candle) => ({
            stock_id: stock.id,
            timestamp: new Date(candle.timestamp * 1000).toISOString(), // convert UNIX seconds to ISO string
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            timeframe: interval,
          }));

          // Upsert into ohlc_data (deduplicate on stock_id+timestamp+timeframe)
          const upsertRes = await supabaseFetch("ohlc_data?on_conflict=stock_id,timestamp,timeframe", {
            method: "POST",
            body: JSON.stringify(rows),
          });
          if (!upsertRes.ok) {
            const err = await upsertRes.text();
            errors.push({ stock_id: stock.id, interval, error: err });
          } else {
            totalCandles += rows.length;
          }
        } catch (err) {
          errors.push({ stock_id: stock.id, interval, error: err.message || String(err) });
        }
        // Rate limit: 1.1s between requests
        await sleep(1100);
      }
    }

    return new Response(JSON.stringify({ success: true, totalCandles, errors }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
