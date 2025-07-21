import Link from 'next/link'

export default function Home() {
  return (
    <main className="flex flex-col items-center justify-center h-screen bg-black">
      <h1 className="text-3xl font-bold text-white mb-8">Welcome to SignalHub2!</h1>
      <Link 
        href="/dashboard" 
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
      >
        View Dashboard
      </Link>
    </main>
  );
} 