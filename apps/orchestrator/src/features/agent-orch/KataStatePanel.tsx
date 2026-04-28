/**
 * KataStatePanel — Collapsible panel showing kata workflow state.
 */

import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import type { KataSessionState } from '~/lib/types'

interface KataStatePanelProps {
  kataState: KataSessionState | null
}

export function KataStatePanel({ kataState }: KataStatePanelProps) {
  const [expanded, setExpanded] = useState(false)

  if (!kataState) return null

  return (
    <div className="border-b px-4 py-2" data-testid="kata-state-panel">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(!expanded)}
        aria-label={expanded ? 'Hide kata status' : 'Show kata status'}
        className="flex items-center gap-1 p-0 text-xs text-muted-foreground hover:text-foreground"
      >
        {expanded ? (
          <ChevronDownIcon className="size-3" />
        ) : (
          <ChevronRightIcon className="size-3" />
        )}
        Kata: {kataState.currentMode || 'unknown'}
        {kataState.currentPhase && <span className="ml-1">/ {kataState.currentPhase}</span>}
      </Button>

      {expanded && (
        <div className="mt-2 flex flex-col gap-1 text-xs">
          {kataState.issueNumber && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Issue:</span>
              <span>#{kataState.issueNumber}</span>
            </div>
          )}
          {kataState.sessionType && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Type:</span>
              <span>{kataState.sessionType}</span>
            </div>
          )}
          {kataState.completedPhases.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Completed:</span>
              <div className="flex flex-wrap gap-1">
                {kataState.completedPhases.map((phase) => (
                  <Badge key={phase} variant="secondary" className="text-[10px]">
                    {phase}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {kataState.phases.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Phases:</span>
              <div className="flex flex-wrap gap-1">
                {kataState.phases.map((phase) => (
                  <Badge
                    key={phase}
                    variant={kataState.completedPhases.includes(phase) ? 'secondary' : 'outline'}
                    className="text-[10px]"
                  >
                    {phase}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
