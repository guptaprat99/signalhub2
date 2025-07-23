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

function getToDateIST() {
  // Today at 15:30:00 IST in 'YYYY-MM-DD HH:mm:ss' format
  const now = new Date();
  // Convert to IST
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} 15:30:00`;
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
    // 1. Fetch all active stocks with required fields
    const stocksRes = await supabaseFetch("stocks?select=id,security_id,exchange_segment,instrument,is_active&is_active=eq.true");
    if (!stocksRes.ok) throw new Error("Failed to fetch stocks");
    const stocks = await stocksRes.json();
    if (!Array.isArray(stocks) || stocks.length === 0) {
      return new Response(JSON.stringify({ error: "No active stocks found" }), { status: 404 });
    }

    // 2. For each stock, fetch OHLC data for the interval(s)
    const intervals: string[] = ["5", "60"]; // 5-min and 1hr intervals
    const nCandles = 210;
    let totalCandles = 0;
    let errors: any[] = [];
    // Optionally, add a list of holidays (YYYY-MM-DD)
    const holidays: string[] = [];

    // Helper to sleep for rate limiting
    function sleep(ms: number) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    for (const stock of stocks) {
      // Skip stocks with missing required fields
      if (!stock.security_id || !stock.exchange_segment || !stock.instrument) continue;
      for (const interval of intervals) {
        try {
          // Calculate fromDate for exactly nCandles (skipping weekends/holidays)
          const fromDate = getFromDateForNCandles(nCandles, interval, holidays);
          const toDate = getToDateIST();
          const tradingDays = getLastNTradingDays(Math.ceil(nCandles / CANDLES_PER_DAY[interval]), holidays);

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

          // Only keep candles within market hours (9:15-15:30 IST) and on trading days
          const filteredCandles = candles.filter((candle) => {
            // candle.timestamp is UNIX seconds (UTC)
            const date = new Date(candle.timestamp * 1000);
            // Convert to IST
            const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
            const dateStr = ist.toISOString().slice(0, 10);
            if (!tradingDays.includes(dateStr)) return false;
            const hour = ist.getUTCHours();
            const min = ist.getUTCMinutes();
            // Market open: 9:15, close: 15:30 IST
            const openMinutes = 9 * 60 + 15;
            const closeMinutes = 15 * 60 + 30;
            const istMinutes = hour * 60 + min;
            return istMinutes >= openMinutes && istMinutes <= closeMinutes;
          });

          // Sort by timestamp ascending, then take last nCandles
          const lastCandles = filteredCandles.sort((a, b) => a.timestamp - b.timestamp).slice(-nCandles);

          if (lastCandles.length === 0) continue;

          // Prepare data for upsert
          const rows = lastCandles.map((candle) => ({
            stock_id: stock.id,
            // Store as UTC ISO string (no offset)
            timestamp: new Date(candle.timestamp * 1000).toISOString(),
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

          // Guarantee only the most recent nCandles remain for this stock/interval
          // 1. Fetch all timestamps for this stock/interval, sorted descending
          const fetchTimestampsRes = await supabaseFetch(
            `ohlc_data?stock_id=eq.${stock.id}&timeframe=eq.${interval}&select=timestamp&order=timestamp.desc`,
            { method: "GET" }
          );
          if (fetchTimestampsRes.ok) {
            const allRows = await fetchTimestampsRes.json();
            if (Array.isArray(allRows) && allRows.length > nCandles) {
              // Collect timestamps to delete (older than the 210th most recent)
              const timestampsToDelete = allRows.slice(nCandles).map(r => r.timestamp);
              // Batch delete (in chunks of 100 for URL length safety)
              for (let i = 0; i < timestampsToDelete.length; i += 100) {
                const chunk = timestampsToDelete.slice(i, i + 100);
                const orClause = chunk.map(ts => `timestamp.eq.${encodeURIComponent(ts)}`).join(",");
                await supabaseFetch(
                  `ohlc_data?stock_id=eq.${stock.id}&timeframe=eq.${interval}&or=(${orClause})`,
                  { method: "DELETE" }
                );
              }
            }
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
