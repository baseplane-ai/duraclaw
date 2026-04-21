import type { ManagedConnection } from './types'

type ChangeListener = (snapshot: ReadonlyArray<ManagedConnection>) => void

// Module-level singleton state. Insertion order preserved by Map — the
// order callers see in `snapshot()` mirrors register-call order.
const sockets = new Map<string, ManagedConnection>()
const listeners = new Set<ChangeListener>()

function emit(): void {
  const snap = Array.from(sockets.values())
  for (const l of listeners) {
    try {
      l(snap)
    } catch (err) {
      console.warn('[cm-registry] change listener threw', err)
    }
  }
}

function snapshot(): ReadonlyArray<ManagedConnection> {
  return Array.from(sockets.values())
}

/**
 * Register a `ManagedConnection`. If `conn.id` already exists, the prior
 * entry is replaced (in-place, so insertion order is preserved for the
 * slot). The returned unregister fn only removes the entry if it is
 * still the same reference that was registered — so a unregister fn
 * from a superseded register() call is a no-op, avoiding accidental
 * removal of the replacement.
 *
 * Replace-with-warn semantics tolerate React StrictMode double-mount:
 * the second register() for the same id just swaps the reference;
 * tests that disable strict mode still get single-registration.
 */
function register(conn: ManagedConnection): () => void {
  const existing = sockets.get(conn.id)
  if (existing && import.meta.env.DEV) {
    console.warn('[cm-registry] replacing existing registration', conn.id)
  }
  sockets.set(conn.id, conn)
  emit()

  return () => {
    // Only remove if we are still the current entry for this id.
    if (sockets.get(conn.id) !== conn) return
    sockets.delete(conn.id)
    emit()
  }
}

function unregister(id: string): ManagedConnection | undefined {
  const prev = sockets.get(id)
  if (!prev) return undefined
  sockets.delete(id)
  emit()
  return prev
}

function onChange(fn: ChangeListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Test-only: drop all registered connections and change listeners.
 * Exported for tests that need a clean singleton between cases.
 */
function __resetForTests(): void {
  sockets.clear()
  listeners.clear()
}

export const connectionRegistry = {
  register,
  unregister,
  snapshot,
  onChange,
  __resetForTests,
}

// Dev-only: expose on `window` for manual inspection via `scripts/axi eval`.
// Tree-shaken out of production builds via the `import.meta.env.DEV` gate.
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  ;(window as unknown as { __connectionRegistry?: unknown }).__connectionRegistry =
    connectionRegistry
}
