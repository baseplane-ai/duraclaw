/**
 * GH#152 P1.4 B12 — inline reactions bar for comment / chat rows.
 *
 * Renders the current chip rollup (one pill per emoji that has count > 0
 * on this target) plus a small "+" button that opens a popover with the
 * MVP `EMOJI_SET`. Clicking either a chip or a popover emoji POSTs to
 * `/api/arcs/:id/reactions/toggle` — the WS echo on `reactions:<arcId>`
 * reconciles the chip state.
 *
 * Coupling is intentionally minimal — props are `{arcId, targetKind,
 * targetId}` so the bar drops into both `CommentThread` (per
 * `CommentRowView`) and `TeamChatPanel` (per chat row) without either
 * surface knowing about the other.
 */

import { useCallback, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import { cn } from '~/lib/utils'
import {
  EMOJI_SET,
  type ReactionTargetKind,
  useReactionActions,
  useReactionsForTarget,
} from './use-arc-reactions'

export interface ReactionsBarProps {
  arcId: string
  targetKind: ReactionTargetKind
  targetId: string
  className?: string
}

export function ReactionsBar({ arcId, targetKind, targetId, className }: ReactionsBarProps) {
  const { chips, userReacted } = useReactionsForTarget(arcId, targetKind, targetId)
  const { toggleReaction } = useReactionActions(arcId)
  const [open, setOpen] = useState(false)

  const onChipClick = useCallback(
    async (emoji: string) => {
      await toggleReaction({ targetKind, targetId, emoji })
    },
    [toggleReaction, targetKind, targetId],
  )

  const onPickerSelect = useCallback(
    async (emoji: string) => {
      setOpen(false)
      await toggleReaction({ targetKind, targetId, emoji })
    },
    [toggleReaction, targetKind, targetId],
  )

  return (
    <div
      className={cn('flex flex-wrap items-center gap-1', className)}
      data-reactions-target-kind={targetKind}
      data-reactions-target-id={targetId}
    >
      {chips.map((chip) => {
        const pressed = userReacted.has(chip.emoji)
        return (
          <button
            key={chip.emoji}
            type="button"
            onClick={() => onChipClick(chip.emoji)}
            data-reaction-chip={chip.emoji}
            data-reaction-pressed={pressed ? 'true' : 'false'}
            className={cn(
              'flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs transition-colors',
              pressed
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <span aria-hidden="true">{chip.emoji}</span>
            <span className="tabular-nums">{chip.count}</span>
          </button>
        )
      })}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label="Add reaction"
          data-reaction-add
          className={cn(
            'flex size-6 items-center justify-center rounded-full border border-border bg-background text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          )}
        >
          <span aria-hidden="true">+</span>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="flex w-auto gap-1 p-1.5"
          data-reaction-picker
        >
          {EMOJI_SET.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onPickerSelect(emoji)}
              data-reaction-pick={emoji}
              className="flex size-7 items-center justify-center rounded text-base hover:bg-accent"
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  )
}
