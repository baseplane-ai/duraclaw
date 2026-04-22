/**
 * Module-level store for chain auto-advance stall reasons (spec
 * 16-chain-ux-p1-5 B9).
 *
 * The SessionDO emits `chain_stalled` on the session WS when auto-advance
 * fires but the precondition gate (or spawn) fails. The client handler in
 * `use-coding-agent.ts` writes the reason here; `ChainStatusItem` reads
 * it via `useStallReason(issueNumber)` to decide whether to render the
 * warning indicator + hover tooltip.
 *
 * Keyed by chain issue number. Transient — not persisted; clears on
 * `chain_advance` for the same issue or on reload. Intentionally small
 * surface, no React; a `useSyncExternalStore` hook is exposed for
 * components but direct imperative reads are fine too.
 */

import { useSyncExternalStore } from 'react'

const store = new Map<number, string>()
const listeners = new Set<() => void>()

export function setStallReason(issueNumber: number, reason: string | null): void {
  if (reason === null) {
    if (!store.has(issueNumber)) return
    store.delete(issueNumber)
  } else {
    if (store.get(issueNumber) === reason) return
    store.set(issueNumber, reason)
  }
  for (const fn of listeners) {
    try {
      fn()
    } catch (err) {
      console.warn('[chain-stall-store] listener threw', err)
    }
  }
}

export function getStallReason(issueNumber: number): string | null {
  return store.get(issueNumber) ?? null
}

export function subscribeToStall(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * React hook: subscribe a component to the stall reason for `issueNumber`.
 * Returns `null` when there's no stored stall (or during SSR snapshot).
 * Used by ChainStatusItem to render the `⚠` indicator + popover banner
 * in response to DO-pushed `chain_stalled` WS events.
 */
export function useStallReason(issueNumber: number): string | null {
  return useSyncExternalStore(
    subscribeToStall,
    () => store.get(issueNumber) ?? null,
    () => null,
  )
}
