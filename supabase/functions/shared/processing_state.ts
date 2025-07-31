// Shared utility for processing state management
// Used across all pipeline functions for delta processing

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

// Get processing state for a function/stock/timeframe combination
export async function getProcessingState(functionName: string, stockId: number, timeframe: string) {
  const res = await supabaseFetch(
    `processing_state?function_name=eq.${functionName}&stock_id=eq.${stockId}&timeframe=eq.${timeframe}&select=*`
  );
  
  if (!res.ok) {
    console.warn(`Failed to get processing state for ${functionName}/${stockId}/${timeframe}`);
    return null;
  }
  
  const states = await res.json();
  return states.length > 0 ? states[0] : null;
}

// Update processing state
export async function updateProcessingState(
  functionName: string, 
  stockId: number, 
  timeframe: string, 
  lastProcessedTimestamp: string,
  status: string = 'completed'
) {
  const stateData = {
    function_name: functionName,
    stock_id: stockId,
    timeframe: timeframe,
    last_processed_timestamp: lastProcessedTimestamp,
    last_run_at: new Date().toISOString(),
    status: status
  };
  
  const res = await supabaseFetch(
    `processing_state?on_conflict=function_name,stock_id,timeframe`,
    {
      method: "POST",
      body: JSON.stringify(stateData),
    }
  );
  
  if (!res.ok) {
    console.error(`Failed to update processing state for ${functionName}/${stockId}/${timeframe}`);
    return false;
  }
  
  return true;
}

// Get new candles since last processed timestamp
export async function getNewCandlesSinceLastProcessed(
  functionName: string, 
  stockId: number, 
  timeframe: string,
  maxCandles: number = 210
) {
  const state = await getProcessingState(functionName, stockId, timeframe);
  const lastProcessed = state?.last_processed_timestamp || '1970-01-01';
  
  // Get all candles since last processed
  const res = await supabaseFetch(
    `ohlc_data?stock_id=eq.${stockId}&timeframe=eq.${timeframe}&timestamp=gt.${encodeURIComponent(lastProcessed)}&order=timestamp.asc&select=*`
  );
  
  if (!res.ok) {
    console.error(`Failed to get new candles for ${stockId}/${timeframe}`);
    return [];
  }
  
  const allNewCandles = await res.json();
  
  if (allNewCandles.length > maxCandles) {
    // Large gap detected - only process the most recent candles
    console.log(`Large gap detected: ${allNewCandles.length} candles for ${stockId}/${timeframe}, processing only last ${maxCandles}`);
    return allNewCandles.slice(-maxCandles);
  }
  
  return allNewCandles;
}

// Get actual last processed timestamp from data tables (for validation)
export async function getActualLastProcessed(functionName: string, stockId: number, timeframe: string) {
  if (functionName === 'compute_signals') {
    // Get from signals table
    const res = await supabaseFetch(
      `signals?stock_id=eq.${stockId}&timeframe=eq.${timeframe}&order=timestamp.desc&limit=1&select=timestamp`
    );
    if (res.ok) {
      const signals = await res.json();
      return signals.length > 0 ? signals[0].timestamp : null;
    }
  } else if (functionName === 'compute_ema_trend') {
    // Get from 9_30_ema_trend table
    const res = await supabaseFetch(
      `9_30_ema_trend?stock_id=eq.${stockId}&timeframe=eq.${timeframe}&order=timestamp.desc&limit=1&select=timestamp`
    );
    if (res.ok) {
      const trends = await res.json();
      return trends.length > 0 ? trends[0].timestamp : null;
    }
  }
  
  return null;
}

// Validate and fix processing state inconsistencies
export async function validateProcessingState(functionName: string, stockId: number, timeframe: string) {
  const state = await getProcessingState(functionName, stockId, timeframe);
  const actualTimestamp = await getActualLastProcessed(functionName, stockId, timeframe);
  
  if (state?.last_processed_timestamp !== actualTimestamp) {
    console.log(`State mismatch detected for ${functionName}/${stockId}/${timeframe}`);
    if (actualTimestamp) {
      await updateProcessingState(functionName, stockId, timeframe, actualTimestamp);
      return actualTimestamp;
    }
  }
  
  return state?.last_processed_timestamp || null;
}

// Get all stock/timeframe pairs that need processing
export async function getStockTimeframePairs() {
  const res = await supabaseFetch(`ohlc_data?select=stock_id,timeframe`);
  
  if (!res.ok) {
    console.error("Failed to fetch stock/timeframe pairs");
    return [];
  }
  
  const allPairs = await res.json();
  
  // Deduplicate pairs
  const seen = new Set();
  const pairs = allPairs.filter((p: any) => {
    const key = `${p.stock_id}|${p.timeframe}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  return pairs;
} 

// Get candles since a specific timestamp (for all functions to use pipeline's timestamp)
export async function getCandlesSinceTimestamp(
  timestamp: string,
  maxCandles: number = 210
) {
  // Get all candles since the specified timestamp
  const res = await supabaseFetch(
    `ohlc_data?timestamp=gt.${encodeURIComponent(timestamp)}&order=timestamp.asc&select=*`
  );
  
  if (!res.ok) {
    console.error(`Failed to get candles since timestamp ${timestamp}`);
    return [];
  }
  
  const allCandles = await res.json();
  
  if (allCandles.length > maxCandles) {
    // Large gap detected - only process the most recent candles
    console.log(`Large gap detected: ${allCandles.length} candles since ${timestamp}, processing only last ${maxCandles}`);
    return allCandles.slice(-maxCandles);
  }
  
  return allCandles;
}

// Get the pipeline's last processed timestamp (single source of truth)
export async function getPipelineLastProcessedTimestamp(): Promise<string> {
  const state = await getProcessingState('pipeline', 0, 'global');
  return state?.last_processed_timestamp || '1970-01-01';
} 