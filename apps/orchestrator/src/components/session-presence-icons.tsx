/**
 * SessionPresenceIcons — compact "who else is in this session" row, sized
 * to fit next to a status dot on a tab or sidebar entry.
 *
 * Reads from `SessionPresenceProvider` via `useSessionPresence`. Renders
 * nothing when the session has no other peers, so idle rows look
 * identical to before this feature shipped.
 *
 * Sizing is intentionally smaller than the main `PresenceBar`:
 * 14px avatars vs 24px, so two avatars + overflow fit comfortably beside
 * a StatusDot without pushing the title off the tab.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'
import { useSessionPresence } from '~/hooks/use-session-presence'

interface Props {
  sessionId: string
  /** Max avatars to show before collapsing into a `+N` chip. Default 2. */
  max?: number
}

function initial(name: string): string {
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed[0].toUpperCase() : '?'
}

export function SessionPresenceIcons({ sessionId, max = 2 }: Props) {
  const peers = useSessionPresence(sessionId)
  if (peers.length === 0) return null

  const visible = peers.length > max ? peers.slice(0, max - 1) : peers
  const overflow = peers.length - visible.length

  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5"
      data-testid="session-presence-icons"
      data-session-id={sessionId}
    >
      {visible.map((peer) => (
        <Tooltip key={peer.id}>
          <TooltipTrigger asChild>
            <span
              className="inline-flex size-3.5 items-center justify-center rounded-full text-[8px] font-medium text-white ring-1 ring-background"
              style={{ backgroundColor: peer.color }}
              data-testid="session-presence-avatar"
              data-user-id={peer.id}
            >
              {initial(peer.name)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{peer.name}</TooltipContent>
        </Tooltip>
      ))}
      {overflow > 0 && (
        <span
          className="inline-flex size-3.5 items-center justify-center rounded-full bg-muted text-[8px] font-medium text-muted-foreground ring-1 ring-background"
          data-testid="session-presence-overflow"
        >
          +{overflow}
        </span>
      )}
    </span>
  )
}
