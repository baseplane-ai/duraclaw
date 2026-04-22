import { useEffect, useMemo, useRef, useState } from 'react'
import { connectionRegistry } from './registry'
import type { ManagedConnection } from './types'

export interface ConnectionStatus {
  /** True iff every registered conn has readyState === WebSocket.OPEN. */
  isOnline: boolean
  connections: Array<{ id: string; readyState: number }>
}

/**
 * React hook that derives a unified online signal across every
 * registered `ManagedConnection`. Subscribes to `connectionRegistry.onChange`
 * for add/remove bookkeeping and to each conn's `open`/`close` events
 * so readyState transitions re-render the consumer.
 *
 * Dynamic subscription bookkeeping: on every registry change we diff
 * the previous snapshot against the new one, installing open/close
 * listeners for added conns and tearing down listeners for removed
 * conns. Prevents stale listeners from outliving their adapter.
 */
export function useConnectionStatus(): ConnectionStatus {
  const [snap, setSnap] = useState<ReadonlyArray<ManagedConnection>>(() =>
    connectionRegistry.snapshot(),
  )
  // readyState is a mutable getter on the adapter — a bump tick
  // forces a re-render so the derived values pick up the new value.
  const [, setTick] = useState(0)

  // id → unsubscribe fn for open/close listeners on each registered
  // adapter. Ref-scoped so it survives re-renders without triggering
  // effect cleanup.
  const perConnUnsubsRef = useRef(new Map<string, () => void>())

  useEffect(() => {
    const bump = () => setTick((t) => t + 1)

    const attach = (conn: ManagedConnection) => {
      if (perConnUnsubsRef.current.has(conn.id)) return
      conn.addEventListener('open', bump)
      conn.addEventListener('close', bump)
      perConnUnsubsRef.current.set(conn.id, () => {
        conn.removeEventListener('open', bump)
        conn.removeEventListener('close', bump)
      })
    }

    const detach = (id: string) => {
      const unsub = perConnUnsubsRef.current.get(id)
      if (!unsub) return
      try {
        unsub()
      } catch (err) {
        console.warn('[useConnectionStatus] detach threw', id, err)
      }
      perConnUnsubsRef.current.delete(id)
    }

    const sync = (nextSnap: ReadonlyArray<ManagedConnection>) => {
      setSnap(nextSnap)
      const nextIds = new Set(nextSnap.map((c) => c.id))

      // Detach removed
      for (const id of Array.from(perConnUnsubsRef.current.keys())) {
        if (!nextIds.has(id)) detach(id)
      }
      // Attach added
      for (const conn of nextSnap) attach(conn)
    }

    const unsub = connectionRegistry.onChange(sync)
    // Initial seed in case the registry changed between render and
    // effect commit.
    sync(connectionRegistry.snapshot())

    return () => {
      unsub()
      for (const un of Array.from(perConnUnsubsRef.current.values())) {
        try {
          un()
        } catch {
          // ignore
        }
      }
      perConnUnsubsRef.current.clear()
    }
  }, [])

  // Perf: every `setTick` bump re-renders this hook, but the derived
  // `{isOnline, connections}` shape only actually changes when the
  // (id, readyState) tuple set changes. Memoise on a stable signature
  // so every downstream consumer doesn't see a fresh object ref
  // (and doesn't cascade-re-render) on every WS heartbeat tick.
  // `sig` is a stable string signature derived from `snap` — memoising
  // on `sig` instead of `snap` is the whole point (snap is a fresh ref
  // on every setTick, sig only changes on a real (id,readyState)
  // transition).
  const sig = snap.map((c) => `${c.id}:${c.readyState}`).join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate — see comment above `sig`.
  return useMemo(() => {
    const connections = snap.map((c) => ({ id: c.id, readyState: c.readyState }))
    // Empty registry → vacuously online.
    const isOnline = snap.every((c) => c.readyState === WebSocket.OPEN)
    return { isOnline, connections }
  }, [sig])
}
