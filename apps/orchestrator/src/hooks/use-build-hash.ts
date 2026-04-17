/**
 * useBuildHash — Aggressive build staleness detection via polling.
 *
 * Fetches `/build-hash.json` (tiny, no-cache) on an interval. When the
 * hash changes from what was loaded at page start, fires `onStale`.
 *
 * This is faster than SW update polling because:
 * - Not subject to SW/HTTP cache rules (explicit cache-bust param)
 * - Detects staleness in seconds, not minutes
 * - Works even if the SW update check is delayed by the browser
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const POLL_INTERVAL = 30_000 // 30 seconds
const INITIAL_DELAY = 5_000 // Wait 5s after mount before first check

interface BuildHashState {
  /** A new build has been deployed */
  stale: boolean
  /** Hash the running app was loaded with */
  localHash: string | null
  /** Latest hash from the server (null until first fetch) */
  remoteHash: string | null
  /** Trigger immediate check */
  checkNow: () => void
}

async function fetchBuildHash(): Promise<string | null> {
  try {
    const res = await fetch(`/build-hash.json?_=${Date.now()}`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = (await res.json()) as { hash?: string }
    return data.hash ?? null
  } catch {
    // Network error — don't treat as stale
    return null
  }
}

export function useBuildHash(): BuildHashState {
  const [stale, setStale] = useState(false)
  const [localHash, setLocalHash] = useState<string | null>(null)
  const [remoteHash, setRemoteHash] = useState<string | null>(null)
  const initialHash = useRef<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const check = useCallback(async () => {
    const hash = await fetchBuildHash()
    if (!hash) return

    setRemoteHash(hash)

    // First successful fetch — store as baseline
    if (initialHash.current === null) {
      initialHash.current = hash
      setLocalHash(hash)
      return
    }

    // Hash changed — new build deployed
    if (hash !== initialHash.current) {
      setStale(true)
    }
  }, [])

  useEffect(() => {
    // Don't poll during SSR or if already stale
    if (typeof window === 'undefined') return

    // Initial check after a short delay (let the page settle)
    const initialTimer = setTimeout(() => {
      check()
      // Then poll on interval
      intervalRef.current = setInterval(check, POLL_INTERVAL)
    }, INITIAL_DELAY)

    return () => {
      clearTimeout(initialTimer)
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [check])

  // Stop polling once stale
  useEffect(() => {
    if (stale && intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [stale])

  return { stale, localHash, remoteHash, checkNow: check }
}
