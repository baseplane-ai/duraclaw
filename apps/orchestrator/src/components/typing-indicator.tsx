/**
 * TypingIndicator — renders "X is typing..." below the chat input.
 *
 * Subscribes to awareness via the "change" event and re-derives the list
 * of peers with `typing === true`. The self client is filtered out so
 * users never see themselves in their own indicator.
 *
 * Dedupe is per-clientId (awareness key), not per user.id — two tabs from
 * the same person counting as two "typists" would be misleading, so we
 * also dedupe by `user.id` when collapsing the list.
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { Awareness } from 'y-protocols/awareness'

interface PeerState {
  user?: { id?: string; name?: string; color?: string }
  typing?: boolean
}

interface TypingIndicatorProps {
  awareness: Awareness
  selfClientId: number
}

function subscribe(awareness: Awareness, cb: () => void): () => void {
  awareness.on('change', cb)
  return () => awareness.off('change', cb)
}

/**
 * Snapshot cache — useSyncExternalStore requires stable refs when the
 * value is unchanged, otherwise React tears on concurrent renders. We
 * compare a small JSON hash of (id,name,typing) tuples instead of
 * returning a fresh array every call.
 */
function readSnapshot(awareness: Awareness, selfClientId: number): string {
  const states = awareness.getStates() as Map<number, PeerState>
  const typists: Array<{ id: string; name: string }> = []
  const seenIds = new Set<string>()
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue
    if (!state.typing) continue
    const id = state.user?.id
    if (!id || seenIds.has(id)) continue
    seenIds.add(id)
    typists.push({ id, name: state.user?.name ?? 'Anonymous' })
  }
  // Sort by id for stable ordering across renders.
  typists.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return JSON.stringify(typists)
}

export function TypingIndicator({ awareness, selfClientId }: TypingIndicatorProps) {
  const sub = useCallback((cb: () => void) => subscribe(awareness, cb), [awareness])
  const getSnapshot = useCallback(
    () => readSnapshot(awareness, selfClientId),
    [awareness, selfClientId],
  )
  const getServerSnapshot = useCallback(() => '[]', [])
  const snapshot = useSyncExternalStore(sub, getSnapshot, getServerSnapshot)
  const typists = JSON.parse(snapshot) as Array<{ id: string; name: string }>

  if (typists.length === 0) return null

  const label =
    typists.length === 1
      ? `${typists[0].name} is typing`
      : typists.length === 2
        ? `${typists[0].name} and ${typists[1].name} are typing`
        : `${typists.length} people are typing`

  return (
    <div
      className="flex items-center gap-1 px-4 py-1 text-xs text-muted-foreground"
      data-testid="typing-indicator"
      aria-live="polite"
    >
      <span>{label}</span>
      <span className="inline-flex gap-0.5" aria-hidden>
        <span
          className="inline-block size-1 animate-pulse rounded-full bg-current"
          style={{ animationDelay: '0ms' }}
        />
        <span
          className="inline-block size-1 animate-pulse rounded-full bg-current"
          style={{ animationDelay: '150ms' }}
        />
        <span
          className="inline-block size-1 animate-pulse rounded-full bg-current"
          style={{ animationDelay: '300ms' }}
        />
      </span>
    </div>
  )
}
