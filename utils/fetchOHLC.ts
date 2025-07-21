// Utility to fetch OHLC data from Dhan API (POST /v2/charts/intraday)
// Compatible with Deno and Node

/**
 * Fetch OHLC data from Dhan API for a given stock and interval.
 * @param {Object} params
 * @param {string} params.dhanToken - Dhan API token
 * @param {string} params.securityId - Dhan security ID
 * @param {string} params.exchangeSegment - Dhan exchange segment
 * @param {string} params.instrument - Dhan instrument
 * @param {string} params.interval - Interval (e.g., '5')
 * @param {string} params.fromDate - From date (YYYY-MM-DD)
 * @param {string} params.toDate - To date (YYYY-MM-DD)
 * @returns {Promise<Array<{ open: number, high: number, low: number, close: number, volume: number, timestamp: number }>>}
 */
export async function fetchOHLC({
  dhanToken,
  securityId,
  exchangeSegment,
  instrument,
  interval,
  fromDate,
  toDate,
}: {
  dhanToken: string;
  securityId: string;
  exchangeSegment: string;
  instrument: string;
  interval: string;
  fromDate: string;
  toDate: string;
}): Promise<Array<{
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}>> {
  const endpoint = 'https://api.dhan.co/v2/charts/intraday';
  const body = {
    securityId,
    exchangeSegment,
    instrument,
    interval,
    oi: false,
    fromDate,
    toDate,
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'access-token': dhanToken,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Dhan API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  // Response: { open: [], high: [], low: [], close: [], volume: [], timestamp: [] }
  if (!data.open || !data.high || !data.low || !data.close || !data.volume || !data.timestamp) {
    throw new Error('Malformed Dhan OHLC response');
  }
  const n = data.open.length;
  const candles = [];
  for (let i = 0; i < n; i++) {
    candles.push({
      open: data.open[i],
      high: data.high[i],
      low: data.low[i],
      close: data.close[i],
      volume: data.volume[i],
      timestamp: data.timestamp[i], // UNIX seconds
    });
  }
  return candles;
}
