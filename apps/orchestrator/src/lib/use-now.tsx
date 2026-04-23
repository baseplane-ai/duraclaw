/**
 * GH#50 — shared `useNow()` tick provider.
 *
 * Returns the current epoch ms, stable between ticks. A single
 * `setInterval(... , 10_000)` runs at the app root and writes through a
 * React context so all time-dependent callers re-render together
 * (rather than each component spinning its own timer).
 *
 * Server-side rendering: `createContext<number>(Date.now())` snapshots
 * once on the server; the browser bumps it on the first client tick
 * after mount. No `setInterval` runs in the SSR pass.
 */

import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'

const NowContext = createContext<number>(Date.now())

const TICK_INTERVAL_MS = 10_000

export function NowProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    // Bump immediately on mount so SSR's static snapshot doesn't linger
    // through the first 10s tick window — important for stale rows that
    // were already past TTL at hydrate time.
    setNow(Date.now())
    const id = setInterval(() => {
      setNow(Date.now())
    }, TICK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  return <NowContext.Provider value={now}>{children}</NowContext.Provider>
}

/**
 * Read the latest tick value. Re-renders only when the shared interval
 * fires (~every 10s) — NOT on every Date.now() read. Pair with
 * time-dependent computations at component callsites.
 */
export function useNow(): number {
  return useContext(NowContext)
}
