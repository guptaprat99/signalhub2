'use client';

import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { getPipelineStatus, triggerPipeline, formatTimestamp } from '../../utils/pipelineStatus';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface StrategyData {
  stock_id: string;
  symbol: string;
  cmp: number;
  prcnt_change: number | null;
  cmp_timestamp: string;
  trend_5min: string | null;
  crossover_5min: string | null;
  trend_60min: string | null;
  crossover_60min: string | null;
  last_updated: string;
}

export default function EMATrendPage() {
  const [strategyData, setStrategyData] = useState<StrategyData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<{ lastRunAt: string | null; isRunning: boolean }>({ lastRunAt: null, isRunning: false });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const fetchStrategyData = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('strategy_9_30_ema')
        .select('*')
        .order('crossover_5min', { ascending: false });

      if (error) throw error;
      setStrategyData(data || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

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
        await fetchStrategyData();
        await updatePipelineStatus();
      }, 2000);
    } catch (err: any) {
      setRefreshError(err.message);
    } finally {
      setRefreshing(false);
    }
  };

  const updatePipelineStatus = async () => {
    const status = await getPipelineStatus();
    setPipelineStatus(status);
  };

  useEffect(() => {
    fetchStrategyData();
    updatePipelineStatus();
    
    // Auto-refresh every 2 minutes
    const interval = setInterval(() => {
      fetchStrategyData();
      updatePipelineStatus();
    }, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const formatPercentage = (value: number | null) => {
    if (value === null) return '-';
    return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  };

  const getTrendColor = (trend: string | null) => {
    if (!trend) return 'text-gray-500';
    return trend === 'Bullish' ? 'text-green-600' : 'text-red-600';
  };

  const getPercentageColor = (value: number | null) => {
    if (value === null) return 'text-gray-500';
    return value > 0 ? 'text-green-600' : value < 0 ? 'text-red-600' : 'text-gray-500';
  };

  if (loading && strategyData.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">9-30 EMA Strategy</h1>
            <p className="mt-2 text-sm text-gray-600">
              Real-time 9-30 EMA strategy analysis with 5-minute and 60-minute trends
            </p>
          </div>
          <div className="flex items-center space-x-4">
            <div className="text-sm text-gray-500">
              Last updated: {formatTimestamp(pipelineStatus.lastRunAt)}
            </div>
            <button
              onClick={refreshData}
              disabled={refreshing}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {refreshing ? 'Processing...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Refresh Error Message */}
        {refreshError && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-md p-4">
            <div className="flex">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-red-800">Refresh Error</h3>
                <div className="mt-2 text-sm text-red-700">{refreshError}</div>
              </div>
            </div>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-md p-4">
            <div className="flex">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-red-800">Error</h3>
                <div className="mt-2 text-sm text-red-700">{error}</div>
              </div>
            </div>
          </div>
        )}

        {/* Data Table */}
        <div className="bg-white shadow-sm rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Symbol
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    CMP
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    % Change
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    CMP Time
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    5min Trend
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    5min Crossover
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    60min Trend
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    60min Crossover
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {strategyData.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-4 text-center text-gray-500">
                      No strategy data available
                    </td>
                  </tr>
                ) : (
                  strategyData.map((row) => (
                    <tr key={row.stock_id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {row.symbol}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        ₹{row.cmp.toFixed(2)}
                      </td>
                      <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${getPercentageColor(row.prcnt_change)}`}>
                        {formatPercentage(row.prcnt_change)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatTimestamp(row.cmp_timestamp)}
                      </td>
                      <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${getTrendColor(row.trend_5min)}`}>
                        {row.trend_5min || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatTimestamp(row.crossover_5min)}
                      </td>
                      <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${getTrendColor(row.trend_60min)}`}>
                        {row.trend_60min || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatTimestamp(row.crossover_60min)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
} 