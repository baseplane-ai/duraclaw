/**
 * SessionPresenceIcons — minimal "someone else is here" indicator for a
 * session tab or sidebar row.
 *
 * Renders a single small dot when `useSessionPresence(sessionId)` returns
 * one or more peers. The tooltip enumerates peer names. No avatars, no
 * overflow chip — the prior multi-avatar layout fought the dense tab's
 * colored-fill look, and all we actually need is "is anyone else here?".
 *
 * The dot's color is the first peer's color (stable per-user via
 * `colorForUserId`), so two tabs shared with different people look
 * subtly distinct on hover without requiring a legend.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'
import { useSessionPresence } from '~/hooks/use-session-presence'

interface Props {
  sessionId: string
}

export function SessionPresenceIcons({ sessionId }: Props) {
  const peers = useSessionPresence(sessionId)
  if (peers.length === 0) return null

  const label =
    peers.length === 1
      ? peers[0].name
      : `${peers.length} others: ${peers.map((p) => p.name).join(', ')}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className="inline-block size-1.5 shrink-0 rounded-full ring-1 ring-background"
          style={{ backgroundColor: peers[0].color }}
          data-testid="session-presence-dot"
          data-session-id={sessionId}
          data-peer-count={peers.length}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
