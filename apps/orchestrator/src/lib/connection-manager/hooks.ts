import { useEffect } from 'react'
import { connectionRegistry } from './registry'
import type { ManagedConnection } from './types'

/**
 * Register a `ManagedConnection` with the global registry for the
 * lifetime of the calling component. Unregisters on unmount OR when
 * the `conn` reference identity changes (session swap → fresh socket).
 * The `id` arg is included in the dependency array so tests that pin
 * a conn reference across id changes still re-register correctly.
 *
 * Pass `null` if the adapter is not yet available (e.g. `useYProvider`
 * hasn't resolved); the effect no-ops. Safe to call on SSR.
 */
export function useManagedConnection(conn: ManagedConnection | null, id: string): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: spec GH#42 B5 mandates [conn, id] — a rename (same adapter, new id) must still re-register.
  useEffect(() => {
    if (!conn) return
    const unregister = connectionRegistry.register(conn)
    return () => {
      unregister()
    }
  }, [conn, id])
}
