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
    // 1. Fetch all tracked stocks
    const stocksRes = await supabaseFetch("stocks?select=symbol");
    if (!stocksRes.ok) throw new Error("Failed to fetch stocks");
    const stocks = await stocksRes.json();
    if (!Array.isArray(stocks) || stocks.length === 0) {
      return new Response(JSON.stringify({ error: "No stocks found" }), { status: 404 });
    }

    // 2. For each stock, fetch OHLC data for both intervals
    const intervals: ("5m" | "1h")[] = ["5m", "1h"];
    let totalCandles = 0;
    let errors: any[] = [];

    for (const stock of stocks) {
      for (const interval of intervals) {
        try {
          // Fetch candles from Dhan
          const candles = await fetchOHLC({
            dhanToken: DHAN_API_TOKEN,
            symbol: stock.symbol,
            interval,
          });

          if (!Array.isArray(candles) || candles.length === 0) continue;

          // Prepare data for upsert
          const rows = candles.map((candle) => ({
            symbol: stock.symbol,
            interval,
            timestamp: candle.timestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          }));

          // Upsert into ohlc_data (deduplicate on symbol+interval+timestamp)
          const upsertRes = await supabaseFetch("ohlc_data?on_conflict=symbol,interval,timestamp", {
            method: "POST",
            body: JSON.stringify(rows),
          });
          if (!upsertRes.ok) {
            const err = await upsertRes.text();
            errors.push({ symbol: stock.symbol, interval, error: err });
          } else {
            totalCandles += rows.length;
          }
        } catch (err) {
          errors.push({ symbol: stock.symbol, interval, error: err.message || String(err) });
        }
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
