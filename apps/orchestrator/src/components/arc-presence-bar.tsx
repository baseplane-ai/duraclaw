/**
 * GH#152 P1.6 (B16) — avatar stack + typing-dots row driven by the
 * composed arc/session presence view.
 *
 * Mirrors `presence-bar.tsx` visually but reads from the higher-level
 * `useArcPresence` hook so the rendering doesn't have to know about the
 * two underlying DOs. Cap of 5 visible avatars; overflow as `+N`.
 *
 * Each avatar's `title` attribute carries `viewing: <viewing>` so hover
 * surfaces context (transcript / chat / inbox / unknown).
 *
 * Empty state — render nothing. The common case for an unobserved arc is
 * "I'm the only one here" → useArcPresence returns an empty array (the
 * local user is filtered out) and the bar should not occupy layout.
 */

import { useArcPresence } from '~/hooks/use-arc-presence'
import { cn } from '~/lib/utils'

interface ArcPresenceBarProps {
  arcId: string
  sessionId: string | null
  className?: string
}

const MAX_VISIBLE = 5

function initial(name: string): string {
  const trimmed = name.trim()
  return trimmed.length > 0 ? (trimmed[0]?.toUpperCase() ?? '?') : '?'
}

export function ArcPresenceBar({ arcId, sessionId, className }: ArcPresenceBarProps) {
  const presence = useArcPresence(arcId, sessionId)
  if (presence.length === 0) return null

  const visible = presence.length > MAX_VISIBLE ? presence.slice(0, MAX_VISIBLE) : presence
  const overflow = presence.length > MAX_VISIBLE ? presence.length - MAX_VISIBLE : 0
  const anyTyping = presence.some((p) => p.typing)

  return (
    <div
      className={cn('flex items-center gap-2', className)}
      data-testid="arc-presence-bar"
      title="Arc presence"
    >
      <ul className="flex list-none items-center gap-1">
        {visible.map((p) => (
          <li key={p.userId}>
            <span
              className="inline-flex size-6 items-center justify-center rounded-full text-[10px] font-medium text-white"
              style={{ backgroundColor: p.color }}
              data-testid="arc-presence-avatar"
              data-user-id={p.userId}
              data-typing={p.typing ? 'true' : undefined}
              title={`${p.displayName} — viewing: ${p.viewing}${p.typing ? ' (typing)' : ''}`}
            >
              {initial(p.displayName)}
            </span>
          </li>
        ))}
        {overflow > 0 && (
          <li>
            <span
              className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
              data-testid="arc-presence-overflow"
            >
              +{overflow}
            </span>
          </li>
        )}
      </ul>
      {anyTyping && (
        <span
          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground"
          data-testid="arc-presence-typing"
          aria-live="polite"
        >
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
      )}
    </div>
  )
}
