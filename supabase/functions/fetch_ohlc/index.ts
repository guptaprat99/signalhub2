// Supabase Edge Function: Fetch OHLC data from Dhan and store in Supabase
// Deno runtime
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// Environment variables
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DHAN_API_TOKEN = Deno.env.get("DHAN_API_TOKEN")!;

// Utility to fetch OHLC data (to be implemented in /utils/fetchOHLC.ts)
import { fetchOHLC } from "../../../utils/fetchOHLC.ts";

// Helper: Supabase client
function supabaseFetch(path: string, options: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });
}

serve(async (_req) => {
  try {
    // 1. Fetch all stocks
    const stocksRes = await supabaseFetch("stocks?select=*");
    if (!stocksRes.ok) throw new Error("Failed to fetch stocks");
    const stocks = await stocksRes.json();

    // 2. For each stock, fetch OHLC data (5min & 1hr)
    const intervals = ["5m", "1h"];
    const allCandles: any[] = [];
    for (const stock of stocks) {
      for (const interval of intervals) {
        // fetchOHLC should return an array of candles for the stock/interval
        const candles = await fetchOHLC({
          dhanToken: DHAN_API_TOKEN,
          symbol: stock.symbol, // assuming 'symbol' field exists
          interval,
        });
        // Attach stock_id and interval to each candle
        for (const candle of candles) {
          allCandles.push({
            ...candle,
            stock_id: stock.id,
            interval,
          });
        }
      }
    }

    // 3. Upsert candles into ohlc_data
    if (allCandles.length > 0) {
      const upsertRes = await supabaseFetch("ohlc_data", {
        method: "POST",
        body: JSON.stringify(allCandles),
      });
      if (!upsertRes.ok) {
        const err = await upsertRes.text();
        throw new Error(`Failed to upsert OHLC data: ${err}`);
      }
    }

    return new Response(JSON.stringify({ success: true, count: allCandles.length }), {
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
