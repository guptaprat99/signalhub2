/// <reference types="deno.ns" />
// Supabase Edge Function: Orchestrator pipeline to run fetch_ohlc and compute_signals in sequence
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_FUNCTIONS_URL = "https://mxdyomqyvrwytuqzpvwk.functions.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function callFunction(path: string) {
  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
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

  const results = [];

  // 1. Run fetch_ohlc
  results.push({ step: "fetch_ohlc", ...(await callFunction("fetch_ohlc")) });

  // 2. Run compute_signals
  results.push({ step: "compute_signals", ...(await callFunction("compute_signals")) });

  // 3. Run compute_ema_trend
  results.push({ step: "compute_ema_trend", ...(await callFunction("compute_ema_trend")) });

  // 4. Run populate_strategy_9_30_ema
  results.push({ step: "populate_strategy_9_30_ema", ...(await callFunction("populate_strategy_9_30_ema")) });

  // Add more steps here as needed

  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}); 