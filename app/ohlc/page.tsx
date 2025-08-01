'use client';

import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { getPipelineStatus, triggerPipeline, formatTimestamp } from '../../utils/pipelineStatus';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type OHLCData = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timeframe: string;
  stocks: {
    symbol: string;
  } | null;
};

// Timeframe display mapping
const TIMEFRAME_LABELS: Record<string, string> = {
  '5': '5min',
  '60': '1hr',
};

export default function OHLCPage() {
  const [data, setData] = useState<OHLCData[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [timeframeFilter, setTimeframeFilter] = useState('');
  const [pipelineStatus, setPipelineStatus] = useState<{ lastRunAt: string | null; isRunning: boolean }>({ lastRunAt: null, isRunning: false });

  // Fetch OHLC data from Supabase
  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);

      const { data: ohlcData, error } = await supabase
        .from('ohlc_data')
        .select('timestamp, open, high, low, close, volume, timeframe, stocks(symbol)')
        .order('timestamp', { ascending: false })
        .limit(800);

      if (error) throw error;
      setData(ohlcData || []);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  };

  // Call Edge Function to refresh data and compute signals
  const refreshData = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const result = await triggerPipeline();
      if (!result.success) {
        throw new Error(result.error || 'Failed to refresh data');
      }
      
      // Wait a bit for pipeline to complete, then refresh data
      setTimeout(async () => {
        await fetchData();
        await updatePipelineStatus();
      }, 2000);
    } catch (err: any) {
      setRefreshError(err.message || 'Failed to refresh data');
    } finally {
      setRefreshing(false);
    }
  };

  const updatePipelineStatus = async () => {
    const status = await getPipelineStatus();
    setPipelineStatus(status);
  };

  // Compute filtered data
  const filteredData = data.filter(row => {
    const symbolMatch = symbolFilter === '' || (row.stocks?.symbol || '').toLowerCase().includes(symbolFilter.toLowerCase());
    const timeframeMatch = timeframeFilter === '' || row.timeframe === timeframeFilter;
    return symbolMatch && timeframeMatch;
  });

  // Set up auto-refresh
  useEffect(() => {
    // Initial fetch
    fetchData();
    updatePipelineStatus();

    // Set up polling if autoRefresh is enabled
    let interval: NodeJS.Timeout;
    if (autoRefresh) {
      interval = setInterval(() => {
        fetchData();
        updatePipelineStatus();
      }, 120000); // 120 seconds
    }

    // Cleanup
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoRefresh]);

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">OHLC Data</h1>
          <div className="flex items-center space-x-4">
            <div className="text-sm text-gray-500">
              Last updated: {formatTimestamp(pipelineStatus.lastRunAt)}
            </div>
            <input
              type="checkbox"
              id="autoRefresh"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="h-4 w-4 text-blue-600 rounded border-gray-300"
            />
            <label htmlFor="autoRefresh" className="text-sm text-gray-600">
              Auto-refresh (2 min)
            </label>
            <button
              onClick={refreshData}
              disabled={refreshing}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {refreshing ? 'Processing...' : 'Refresh'}
            </button>
          </div>
        </div>
        
        {/* Refresh error message */}
        {refreshError && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            {refreshError}
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="text-center py-4 text-gray-600">Loading...</div>
        )}

        {/* Data table */}
        {/* Filters */}
        <div className="flex flex-wrap gap-4 mb-4">
          <div>
            <label htmlFor="symbolFilter" className="block text-xs font-medium text-gray-700 mb-1">Filter by Symbol</label>
            <input
              type="text"
              id="symbolFilter"
              value={symbolFilter}
              onChange={(e) => setSymbolFilter(e.target.value)}
              placeholder="Enter symbol..."
              className="px-3 py-1 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="timeframeFilter" className="block text-xs font-medium text-gray-700 mb-1">Filter by Timeframe</label>
            <select
              id="timeframeFilter"
              value={timeframeFilter}
              onChange={(e) => setTimeframeFilter(e.target.value)}
              className="px-3 py-1 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All timeframes</option>
              <option value="5">5min</option>
              <option value="60">1hr</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white shadow-sm rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Symbol</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Timeframe</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Timestamp</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Open</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">High</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Low</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Close</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Volume</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredData.map((row, idx) => (
                  <tr key={`${row.stocks?.symbol}-${row.timeframe}-${row.timestamp}-${idx}`}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{row.stocks?.symbol}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{TIMEFRAME_LABELS[row.timeframe] || row.timeframe}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatTimestamp(row.timestamp)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{row.open.toFixed(2)}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{row.high.toFixed(2)}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{row.low.toFixed(2)}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{row.close.toFixed(2)}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">{row.volume.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
} 