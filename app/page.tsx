import { supabase } from '@/lib/supabase'

export default async function HomePage() {
  const { data: stocks, error } = await supabase.from('stocks').select('symbol, name')

  if (error) {
    return <div>Error: {error.message}</div>
  }

  return (
    <main className="p-4">
      <h1 className="text-xl font-bold mb-4">Tracked Stocks</h1>
      <ul className="space-y-2">
        {stocks?.map((stock) => (
          <li key={stock.symbol} className="border p-2 rounded">
            <strong>{stock.symbol}</strong>: {stock.name}
          </li>
        ))}
      </ul>
    </main>
  )
} 