import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export interface PipelineStatus {
  lastRunAt: string | null;
  isRunning: boolean;
}

export async function getPipelineStatus(): Promise<PipelineStatus> {
  try {
    // Get the latest run timestamp from processing_state table for the pipeline function
    const { data, error } = await supabase
      .from('processing_state')
      .select('last_run_at, status')
      .eq('function_name', 'pipeline')
      .eq('stock_id', 0)
      .eq('timeframe', 'global')
      .order('last_run_at', { ascending: false })
      .limit(1);

    if (error) throw error;
    
    const lastRunAt = data && data.length > 0 ? data[0].last_run_at : null;
    const isRunning = data && data.length > 0 ? data[0].status === 'processing' : false;
    
    return {
      lastRunAt,
      isRunning
    };
  } catch (error) {
    console.error('Error getting pipeline status:', error);
    return {
      lastRunAt: null,
      isRunning: false
    };
  }
}

export async function triggerPipeline(): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch('https://mxdyomqyvrwytuqzpvwk.functions.supabase.co/pipeline', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      },
    });
    
    const result = await res.json();
    
    if (!res.ok) {
      throw new Error(result.error || 'Failed to trigger pipeline');
    }
    
    return { success: true };
  } catch (error: any) {
    console.error('Error triggering pipeline:', error);
    return { success: false, error: error.message };
  }
}

export function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return '-';
  
  const date = new Date(timestamp);
  const istDate = new Date(date.getTime() + 5.5 * 60 * 60 * 1000); // Convert to IST
  
  const day = istDate.getUTCDate().toString().padStart(2, '0');
  const month = istDate.toLocaleString('en-US', { month: 'short' });
  const year = istDate.getUTCFullYear().toString().slice(-2);
  const hours = istDate.getUTCHours().toString().padStart(2, '0');
  const minutes = istDate.getUTCMinutes().toString().padStart(2, '0');
  
  return `${day}-${month}-${year} ${hours}:${minutes}`;
} 