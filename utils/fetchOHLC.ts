// Utility to fetch OHLC data from Dhan API
// Compatible with Deno and Node

/**
 * Fetch OHLC data from Dhan API for a given symbol and interval.
 * @param {Object} params
 * @param {string} params.dhanToken - Dhan API token
 * @param {string} params.symbol - Stock symbol
 * @param {string} params.interval - Interval ('5m' or '1h')
 * @returns {Promise<Array<{ open: number, high: number, low: number, close: number, volume: number, timestamp: string }>>}
 */
export async function fetchOHLC({ dhanToken, symbol, interval }: {
  dhanToken: string;
  symbol: string;
  interval: '5m' | '1h';
}): Promise<Array<{
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
}>> {
  // Dhan API endpoint for OHLC (replace with actual endpoint if different)
  const endpoint = `https://api.dhan.co/market/ohlc?symbol=${encodeURIComponent(symbol)}&interval=${interval}`;

  const res = await fetch(endpoint, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${dhanToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Dhan API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  // Assume data.candles is an array of [timestamp, open, high, low, close, volume]
  if (!data.candles || !Array.isArray(data.candles)) {
    throw new Error('Malformed Dhan OHLC response');
  }

  return data.candles.map((candle: any) => ({
    timestamp: candle[0],
    open: candle[1],
    high: candle[2],
    low: candle[3],
    close: candle[4],
    volume: candle[5],
  }));
}
