/**
 * PresenceBar — horizontal row of avatar dots for every user currently
 * connected to this session's collab room. Subscribes to awareness and
 * dedupes by `user.id` so two tabs from the same human show a single
 * avatar.
 *
 * Overflow: when > 5 users, show first 4 + "+N" badge. P3a does not
 * animate disconnect fade — that's B9 / P3b territory.
 */

import { useSyncExternalStore } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'

interface PeerState {
  user?: { id?: string; name?: string; color?: string }
}

interface PresenceUser {
  id: string
  name: string
  color: string
}

interface PresenceBarProps {
  awareness: Awareness
  selfClientId: number
}

function subscribe(awareness: Awareness, cb: () => void): () => void {
  awareness.on('change', cb)
  return () => awareness.off('change', cb)
}

function readSnapshot(awareness: Awareness, selfClientId: number): string {
  const states = awareness.getStates() as Map<number, PeerState>
  const seen = new Map<string, PresenceUser>()
  // Include self so the viewer sees their own avatar too.
  // Order: put self first when present, then peers sorted by id.
  let selfUser: PresenceUser | null = null
  const peers: PresenceUser[] = []
  for (const [clientId, state] of states) {
    const id = state.user?.id
    if (!id) continue
    if (seen.has(id)) continue
    const user: PresenceUser = {
      id,
      name: state.user?.name ?? 'Anonymous',
      color: state.user?.color ?? '#94a3b8',
    }
    seen.set(id, user)
    if (clientId === selfClientId) {
      selfUser = user
    } else {
      peers.push(user)
    }
  }
  peers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const ordered = selfUser ? [selfUser, ...peers] : peers
  return JSON.stringify(ordered)
}

function initial(name: string): string {
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed[0].toUpperCase() : '?'
}

export function PresenceBar({ awareness, selfClientId }: PresenceBarProps) {
  const snapshot = useSyncExternalStore(
    (cb) => subscribe(awareness, cb),
    () => readSnapshot(awareness, selfClientId),
    () => '[]',
  )
  const users = JSON.parse(snapshot) as PresenceUser[]
  if (users.length === 0) return null

  const visible = users.length > 5 ? users.slice(0, 4) : users
  const overflow = users.length > 5 ? users.length - 4 : 0

  return (
    <ul
      className="flex list-none items-center gap-1 px-4 py-1"
      data-testid="presence-bar"
      aria-label="Connected users"
    >
      {visible.map((u) => (
        <li key={u.id}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex size-6 items-center justify-center rounded-full text-[10px] font-medium text-white"
                style={{ backgroundColor: u.color }}
                data-testid="presence-avatar"
                data-user-id={u.id}
              >
                {initial(u.name)}
              </span>
            </TooltipTrigger>
            <TooltipContent>{u.name}</TooltipContent>
          </Tooltip>
        </li>
      ))}
      {overflow > 0 && (
        <li>
          <span
            className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
            data-testid="presence-overflow"
          >
            +{overflow}
          </span>
        </li>
      )}
    </ul>
  )
}
