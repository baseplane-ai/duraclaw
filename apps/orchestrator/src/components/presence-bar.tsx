/**
 * PresenceBar — horizontal row of avatar dots for every user currently
 * connected to this session's collab room. Subscribes to awareness and
 * dedupes by `user.id` so two tabs from the same human show a single
 * avatar.
 *
 * Overflow: when > 5 users, show first 4 + "+N" badge.
 *
 * Ghost presence (B9 + B8): when a peer disappears from awareness
 * (typically because they switched tabs and YProvider tore down its WS,
 * which causes y-protocols to drop their awareness entry), we keep their
 * avatar in the DOM for 5 seconds with a fade-out animation so it
 * doesn't flicker away instantly. Tooltip during the fade is
 * "Left recently". After 5s the avatar is removed.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'

interface PeerState {
  user?: { id?: string; name?: string; color?: string }
}

interface PresenceUser {
  id: string
  name: string
  color: string
  isSelf: boolean
}

interface PresenceBarProps {
  awareness: Awareness
  selfClientId: number
}

const GHOST_MS = 5000

function subscribe(awareness: Awareness, cb: () => void): () => void {
  awareness.on('change', cb)
  return () => awareness.off('change', cb)
}

function readSnapshot(awareness: Awareness, selfClientId: number): string {
  const states = awareness.getStates() as Map<number, PeerState>
  const selfUserId = states.get(selfClientId)?.user?.id

  // Pass 1: pick one canonical state per user.id. When two clientIds share
  // the same user.id (multi-tab self), prefer the entry whose clientId
  // matches selfClientId so the self user is always recognised as self
  // regardless of Map iteration order.
  const chosen = new Map<string, { state: PeerState; clientId: number }>()
  for (const [clientId, state] of states) {
    const id = state.user?.id
    if (!id) continue
    const existing = chosen.get(id)
    if (!existing) {
      chosen.set(id, { state, clientId })
      continue
    }
    if (id === selfUserId && clientId === selfClientId) {
      chosen.set(id, { state, clientId })
    }
  }

  // Pass 2: build self + peers with preserved ordering (self first, peers
  // sorted by id).
  let selfUser: PresenceUser | null = null
  const peers: PresenceUser[] = []
  for (const [id, { state }] of chosen) {
    const isSelf = selfUserId !== undefined && id === selfUserId
    const user: PresenceUser = {
      id,
      name: state.user?.name ?? 'Anonymous',
      color: state.user?.color ?? '#94a3b8',
      isSelf,
    }
    if (isSelf) {
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

/**
 * Keyframes for the 5s fade-out. Injected once on first render so we
 * don't depend on a global CSS file.
 */
const KEYFRAMES = `@keyframes collab-fade-out { 0% { opacity: 1 } 100% { opacity: 0 } }`
let keyframesInjected = false
function ensureKeyframes() {
  if (typeof document === 'undefined') return
  if (keyframesInjected) return
  const style = document.createElement('style')
  style.setAttribute('data-collab-keyframes', '')
  style.textContent = KEYFRAMES
  document.head.appendChild(style)
  keyframesInjected = true
}

interface DisplayUser extends PresenceUser {
  departedAt?: number
}

export function PresenceBar({ awareness, selfClientId }: PresenceBarProps) {
  const sub = useCallback((cb: () => void) => subscribe(awareness, cb), [awareness])
  const getSnapshot = useCallback(
    () => readSnapshot(awareness, selfClientId),
    [awareness, selfClientId],
  )
  const getServerSnapshot = useCallback(() => '[]', [])
  const snapshot = useSyncExternalStore(sub, getSnapshot, getServerSnapshot)

  // Internal map: userId -> { user, departedAt? }. Persisted across
  // renders via a ref. We mirror it into state so React re-renders when
  // the ghost set changes (fade-out / removal).
  const ghostsRef = useRef<Map<string, DisplayUser>>(new Map())
  const [, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((n) => (n + 1) % 1_000_000), [])

  // Reconcile awareness -> internal map whenever awareness snapshot
  // changes. Users present now: clear any `departedAt`. Users absent
  // now but previously tracked: stamp `departedAt` on first absence.
  useEffect(() => {
    ensureKeyframes()
    const current = JSON.parse(snapshot) as PresenceUser[]
    const currentIds = new Set(current.map((u) => u.id))
    const now = Date.now()
    const map = ghostsRef.current
    let changed = false

    for (const u of current) {
      const prev = map.get(u.id)
      if (!prev || prev.departedAt !== undefined) {
        map.set(u.id, { ...u })
        changed = true
      } else if (prev.name !== u.name || prev.color !== u.color || prev.isSelf !== u.isSelf) {
        map.set(u.id, { ...u })
        changed = true
      }
    }

    for (const [id, display] of map) {
      if (currentIds.has(id)) continue
      if (display.departedAt === undefined) {
        map.set(id, { ...display, departedAt: now })
        changed = true
      }
    }

    if (changed) bump()
  }, [snapshot, bump])

  // Tick every second while ghosts are pending — once `Date.now() -
  // departedAt > GHOST_MS`, evict. Single interval shared by all ghosts.
  useEffect(() => {
    // Read `snapshot` so this effect restarts when awareness changes
    // (new peer departs -> need the eviction interval running). Without
    // the reference the dep is flagged unused and the interval would
    // either never start or tear down / recreate on every render.
    void snapshot
    const map = ghostsRef.current
    const hasGhosts = Array.from(map.values()).some((d) => d.departedAt !== undefined)
    if (!hasGhosts) return
    const id = setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [key, display] of map) {
        if (display.departedAt !== undefined && now - display.departedAt > GHOST_MS) {
          map.delete(key)
          changed = true
        }
      }
      if (changed) bump()
    }, 500)
    return () => clearInterval(id)
  }, [snapshot, bump])

  const all = Array.from(ghostsRef.current.values())
  if (all.length === 0) return null

  // Preserve existing sort: self first, then peers by id. Present users
  // before ghosts so fading avatars don't push live ones around.
  const liveSelf = all.find((u) => u.isSelf && u.departedAt === undefined)
  const livePeers = all
    .filter((u) => !u.isSelf && u.departedAt === undefined)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const ghostPeers = all
    .filter((u) => u.departedAt !== undefined)
    .sort((a, b) => (a.departedAt ?? 0) - (b.departedAt ?? 0))

  const ordered = [...(liveSelf ? [liveSelf] : []), ...livePeers, ...ghostPeers]

  const visible = ordered.length > 5 ? ordered.slice(0, 4) : ordered
  const overflow = ordered.length > 5 ? ordered.length - 4 : 0

  return (
    <ul
      className="flex list-none items-center gap-1 px-4 py-1"
      data-testid="presence-bar"
      aria-label="Connected users"
    >
      {visible.map((u) => {
        const isGhost = u.departedAt !== undefined
        const avatarStyle: React.CSSProperties = { backgroundColor: u.color }
        if (isGhost) {
          avatarStyle.animation = 'collab-fade-out 5s linear forwards'
        }
        return (
          <li key={u.id}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex size-6 items-center justify-center rounded-full text-[10px] font-medium text-white"
                  style={avatarStyle}
                  data-testid="presence-avatar"
                  data-user-id={u.id}
                  data-ghost={isGhost ? 'true' : undefined}
                >
                  {initial(u.name)}
                </span>
              </TooltipTrigger>
              <TooltipContent>{isGhost ? 'Left recently' : u.name}</TooltipContent>
            </Tooltip>
          </li>
        )
      })}
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
