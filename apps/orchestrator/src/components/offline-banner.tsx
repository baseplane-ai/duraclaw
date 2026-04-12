import { useEffect, useState } from 'react'

export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(false)

  useEffect(() => {
    const goOffline = () => setIsOffline(true)
    const goOnline = () => setIsOffline(false)

    // Check initial state
    setIsOffline(!navigator.onLine)

    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [])

  if (!isOffline) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-center gap-2 bg-yellow-500 px-4 py-2 text-sm font-medium text-yellow-950">
      <span>You are offline</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded bg-yellow-950/10 px-2 py-0.5 text-xs font-semibold hover:bg-yellow-950/20"
      >
        Retry
      </button>
    </div>
  )
}
