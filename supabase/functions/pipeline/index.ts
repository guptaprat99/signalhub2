/// <reference types="deno.ns" />
// Supabase Edge Function: Orchestrator pipeline to run fetch_ohlc and compute_signals in sequence
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { updateProcessingState } from "../shared/processing_state.ts";

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

async function updatePipelineStatus(success: boolean, error?: string) {
  try {
    // Use the shared updateProcessingState function
    await updateProcessingState(
      'pipeline',
      0, // Global pipeline status
      'global',
      new Date().toISOString(),
      success ? 'completed' : 'failed'
    );
    console.log('Pipeline status updated successfully');
  } catch (error) {
    console.error('Error updating pipeline status:', error);
  }
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
  let pipelineSuccess = true;
  let pipelineError = null;

  try {
    // 1. Run fetch_ohlc (always runs - fetches fresh data)
    console.log("Starting fetch_ohlc...");
    const fetchResult = await callFunction("fetch_ohlc");
    results.push({ step: "fetch_ohlc", ...fetchResult });
    if (!fetchResult.ok) {
      pipelineSuccess = false;
      pipelineError = `fetch_ohlc failed: ${fetchResult.body}`;
    }

    // 2. Run compute_signals (delta processing)
    console.log("Starting compute_signals...");
    const signalsResult = await callFunction("compute_signals");
    results.push({ step: "compute_signals", ...signalsResult });
    if (!signalsResult.ok) {
      pipelineSuccess = false;
      pipelineError = `compute_signals failed: ${signalsResult.body}`;
    }

    // 3. Run compute_ema_trend (delta processing)
    console.log("Starting compute_ema_trend...");
    const trendResult = await callFunction("compute_ema_trend");
    results.push({ step: "compute_ema_trend", ...trendResult });
    if (!trendResult.ok) {
      pipelineSuccess = false;
      pipelineError = `compute_ema_trend failed: ${trendResult.body}`;
    }

    // 4. Run populate_strategy_9_30_ema (delta processing)
    console.log("Starting populate_strategy_9_30_ema...");
    const strategyResult = await callFunction("populate_strategy_9_30_ema");
    results.push({ step: "populate_strategy_9_30_ema", ...strategyResult });
    if (!strategyResult.ok) {
      pipelineSuccess = false;
      pipelineError = `populate_strategy_9_30_ema failed: ${strategyResult.body}`;
    }

    // Update pipeline status
    await updatePipelineStatus(pipelineSuccess, pipelineError);

  } catch (error: any) {
    console.error("Pipeline error:", error);
    pipelineSuccess = false;
    pipelineError = error.message;
    await updatePipelineStatus(pipelineSuccess, pipelineError);
  }

  return new Response(JSON.stringify({ 
    success: pipelineSuccess,
    error: pipelineError,
    results 
  }), {
    status: pipelineSuccess ? 200 : 500,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}); 