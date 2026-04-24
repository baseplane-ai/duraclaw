/**
 * AwaitingBubble — placeholder assistant row shown between a just-sent user
 * turn and the first runner event (spec #80 B9 / P1.5).
 *
 * The DO stamps `{type: 'awaiting_response', state: 'pending', reason}` on
 * the tail user message at every turn-entry point and clears it on the
 * first runner event. `ChatThread` detects that part and renders this
 * component into the same structural slot the next assistant row will
 * occupy so the swap is a content change, not a layout jump.
 *
 * Copy is keyed by reason — only `first_token` is reachable in v1; the
 * other three are reserved strings for future SDK hookups (subagent,
 * monitor, async-wake).
 */

import { Message, MessageContent } from '@duraclaw/ai-elements'
import type { AwaitingReason } from '~/lib/awaiting-response'

const COPY: Record<AwaitingReason, string> = {
  first_token: 'Claude is thinking…',
  subagent: 'Running subagent…',
  monitor: 'Watching monitor…',
  async_wake: 'Waiting for response…',
}

interface AwaitingBubbleProps {
  reason: AwaitingReason
}

/**
 * Outermost wrapper mirrors the assistant-row container in `ChatThread`
 * (`<div className="group relative">`) so slot continuity holds: when the
 * awaiting part is cleared and the real assistant row mounts in the same
 * virtualized list slot, React performs a content swap rather than a
 * layout jump.
 */
export function AwaitingBubble({ reason }: AwaitingBubbleProps) {
  const label = COPY[reason]
  return (
    <div className="group relative" data-testid="awaiting-bubble" role="status" aria-live="polite">
      <div className="space-y-2">
        <Message from="assistant">
          <MessageContent>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
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
          </MessageContent>
        </Message>
      </div>
    </div>
  )
}
