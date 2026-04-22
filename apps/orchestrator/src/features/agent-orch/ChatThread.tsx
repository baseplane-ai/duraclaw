/**
 * ChatThread — Renders the CodingAgent conversation as a chat thread.
 *
 * Renders SessionMessage parts directly using shared ai-elements components.
 */

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  Message,
  MessageContent,
  MessageResponse,
  Suggestion,
  Suggestions,
  Tool,
  ToolContent,
  ToolHeader,
  type ToolHeaderProps,
  ToolInput,
  ToolOutput,
} from '@duraclaw/ai-elements'
import {
  BrainIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FileIcon,
  HistoryIcon,
} from 'lucide-react'
import { memo, type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import { Badge } from '~/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { Skeleton } from '~/components/ui/skeleton'
import type { DerivedGatePayload } from '~/hooks/use-derived-gate'
import { getImagePartDataUrl } from '~/lib/message-parts'
import type { GateResponse, SessionMessage, SessionMessagePart } from '~/lib/types'
import { GateResolver } from './GateResolver'

function getToolName(part: SessionMessagePart): string {
  return part.toolName || (part.type || '').replace(/^tool-/, '')
}

function getFilePath(part: SessionMessagePart): string | null {
  const input = part.input as { file_path?: unknown; notebook_path?: unknown } | null | undefined
  if (!input || typeof input !== 'object') return null
  const fp = input.file_path ?? input.notebook_path
  return typeof fp === 'string' && fp.length > 0 ? fp : null
}

function groupByFilePath(parts: SessionMessagePart[]): {
  grouped: Array<{ filePath: string; parts: SessionMessagePart[] }>
  ungrouped: SessionMessagePart[]
} {
  const byPath = new Map<string, SessionMessagePart[]>()
  const ungrouped: SessionMessagePart[] = []
  for (const p of parts) {
    const fp = getFilePath(p)
    if (fp) {
      const arr = byPath.get(fp)
      if (arr) arr.push(p)
      else byPath.set(fp, [p])
    } else {
      ungrouped.push(p)
    }
  }
  return {
    grouped: Array.from(byPath.entries()).map(([filePath, ps]) => ({ filePath, parts: ps })),
    ungrouped,
  }
}

// Any ask_user / permission part with an id. Used to keep these parts OUT of
// the ToolPillRow chip bucket — gate prompts must never have a collapsed-chip
// alternative display path, otherwise a part whose state lags behind the
// session gate (e.g. a state-update event that arrived while the tab was
// blurred and got batched on refocus) silently renders as a badge instead of
// the inline GateResolver UI.
function isGateCandidate(part: SessionMessagePart): boolean {
  return (part.type === 'tool-ask_user' || part.type === 'tool-permission') && !!part.toolCallId
}

function isPendingGate(
  part: SessionMessagePart,
  readOnly: boolean | undefined,
  derivedGate: DerivedGatePayload | null,
): boolean {
  if (!isGateCandidate(part) || readOnly) return false
  // Spec-31 B7: message-derived gate. The part's own state is the primary
  // signal; we also accept the derived-gate pointer as a defensive match
  // in case the part's state hasn't propagated yet (parity with the
  // pre-P4b dual signal, minus the SessionState.gate path).
  if (part.state === 'approval-requested') return true
  if (derivedGate && part.toolCallId && derivedGate.id === part.toolCallId) return true
  return false
}

/**
 * Parse the question text out of an ask_user part's `input`. Mirrors the
 * shape-handling in GateResolver so resolved history and the live prompt
 * read from the same source. Returns a list of display-ready question
 * strings (one per structured question, or a single legacy string).
 */
function parseAskUserQuestions(input: unknown): string[] {
  if (!input || typeof input !== 'object') {
    return [typeof input === 'string' ? input : JSON.stringify(input)]
  }
  const obj = input as { questions?: unknown; question?: unknown }
  if (Array.isArray(obj.questions) && obj.questions.length > 0) {
    return (obj.questions as Array<{ question?: unknown }>).map((q) =>
      typeof q?.question === 'string' ? q.question : '',
    )
  }
  if (typeof obj.question === 'string') return [obj.question]
  return [JSON.stringify(input)]
}

function ResolvedAskUser({ part }: { part: SessionMessagePart }) {
  const questions = parseAskUserQuestions(part.input)
  const denied = part.state === 'output-denied'
  const answer = denied
    ? 'Declined'
    : typeof part.output === 'string'
      ? part.output
      : part.output != null
        ? JSON.stringify(part.output)
        : ''
  return (
    <div className="min-w-0 space-y-1 rounded-lg border-l-2 border-info/30 bg-info/5 p-3">
      {questions.map((q, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: questions share no stable id
        <p key={`q-${i}`} className="break-words text-sm">
          <span className="font-medium text-muted-foreground">Q:</span> {q}
        </p>
      ))}
      {answer && (
        <p className="break-words text-sm">
          <span className="font-medium text-muted-foreground">A:</span> {answer}
        </p>
      )}
    </div>
  )
}

function ToolCallDetail({ part }: { part: SessionMessagePart }) {
  const state = (part.state as ToolHeaderProps['state']) ?? 'input-available'
  return (
    <Tool defaultOpen>
      <ToolHeader
        {...({
          type: 'dynamic-tool',
          toolName: getToolName(part),
          state,
        } as ToolHeaderProps)}
      />
      <ToolContent>
        <ToolInput input={part.input} />
        {(state === 'output-available' || state === 'output-error') && (
          <ToolOutput
            output={part.output}
            errorText={state === 'output-error' ? String(part.output ?? 'Error') : undefined}
          />
        )}
      </ToolContent>
    </Tool>
  )
}

function ToolPillRow({ parts }: { parts: SessionMessagePart[] }) {
  const [selected, setSelected] = useState<string | null>(null)

  const groups = useMemo(() => {
    const map = new Map<string, SessionMessagePart[]>()
    for (const p of parts) {
      const name = getToolName(p)
      const arr = map.get(name)
      if (arr) arr.push(p)
      else map.set(name, [p])
    }
    return map
  }, [parts])

  const selectedParts = selected ? groups.get(selected) : undefined
  const selectedSplit = useMemo(
    () => (selectedParts ? groupByFilePath(selectedParts) : null),
    [selectedParts],
  )
  // When only one file group exists (and no ungrouped), expand it by default so
  // the single-file common case doesn't force an extra click.
  const autoExpandSingleFile =
    !!selectedSplit && selectedSplit.grouped.length === 1 && selectedSplit.ungrouped.length === 0

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {Array.from(groups.entries()).map(([name, grp]) => (
          <Badge
            key={name}
            asChild
            variant="secondary"
            className="rounded-full px-2.5 py-0.5 font-normal"
          >
            <button
              type="button"
              onClick={() => setSelected(name)}
              aria-label={`Show ${grp.length} ${name} call${grp.length === 1 ? '' : 's'}`}
            >
              <span className="font-mono">{name}</span>
              {grp.length > 1 && <span className="text-muted-foreground">×{grp.length}</span>}
            </button>
          </Badge>
        ))}
      </div>
      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-2xl">
          <SheetHeader className="border-b">
            <SheetTitle className="font-mono">{selected}</SheetTitle>
            <SheetDescription>
              {selectedParts?.length ?? 0} call{(selectedParts?.length ?? 0) === 1 ? '' : 's'}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {selectedSplit?.grouped.map(({ filePath, parts: fileParts }) => (
              <details
                key={filePath}
                open={autoExpandSingleFile || fileParts.length === 1}
                className="rounded-md border"
              >
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50">
                  <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono">{filePath}</span>
                  {fileParts.length > 1 && (
                    <span className="shrink-0 text-muted-foreground text-xs">
                      ×{fileParts.length}
                    </span>
                  )}
                </summary>
                <div className="space-y-3 border-t p-3">
                  {fileParts.map((p, i) => (
                    <ToolCallDetail key={p.toolCallId ?? i} part={p} />
                  ))}
                </div>
              </details>
            ))}
            {selectedSplit?.ungrouped.map((p, i) => (
              <ToolCallDetail key={p.toolCallId ?? `u-${i}`} part={p} />
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

function ReasoningPillRow({ parts }: { parts: SessionMessagePart[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <Badge asChild variant="secondary" className="rounded-full px-2.5 py-0.5 font-normal">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={`Show ${parts.length} thought${parts.length === 1 ? '' : 's'}`}
          >
            <BrainIcon className="mr-1 size-3" />
            <span>Thought for a few seconds</span>
            {parts.length > 1 && <span className="text-muted-foreground">×{parts.length}</span>}
          </button>
        </Badge>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-2xl">
          <SheetHeader className="border-b">
            <SheetTitle>Reasoning</SheetTitle>
            <SheetDescription>
              {parts.length} thought{parts.length === 1 ? '' : 's'}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {parts.map((p, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: reasoning parts share no stable id; order is fixed
                key={i}
                className="rounded-md border bg-muted/30 p-3"
              >
                <div className="mb-2 flex items-center gap-1.5 text-muted-foreground text-xs">
                  <BrainIcon className="size-3" />
                  <span>Thought #{i + 1}</span>
                </div>
                <div className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {p.text || '(empty)'}
                </div>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

interface MessageBranchProps {
  current: number
  total: number
  onNavigate: (direction: 'prev' | 'next') => void
}

function MessageBranch({ current, total, onNavigate }: MessageBranchProps) {
  if (total <= 1) return null
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => onNavigate('prev')}
        disabled={current <= 1}
        className="rounded p-0.5 hover:bg-accent disabled:opacity-30"
        aria-label="Previous branch"
      >
        <ChevronLeftIcon className="size-3.5" />
      </button>
      <span className="min-w-[2ch] text-center">
        {current}/{total}
      </span>
      <button
        type="button"
        onClick={() => onNavigate('next')}
        disabled={current >= total}
        className="rounded p-0.5 hover:bg-accent disabled:opacity-30"
        aria-label="Next branch"
      >
        <ChevronRightIcon className="size-3.5" />
      </button>
    </div>
  )
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null)

  const copy = useCallback(() => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => setCopied(false), 2000)
  }, [text])

  const Icon = copied ? CheckIcon : CopyIcon

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
      aria-label="Copy message"
    >
      <Icon className="size-3.5" />
    </button>
  )
}

interface ChatThreadProps {
  /**
   * Identity of the session whose messages we render. Threaded through to
   * `<Conversation key={sessionId}>` so the IntersectionObserver +
   * ResizeObserver instances owned by `useAutoScroll` are torn down and
   * re-armed cleanly on session switch. Without the key, tabs-stay-mounted
   * (#51) means the same observer survives the `messages` prop swap and
   * fires against the wrong baseline — exactly the "heavy-session switch
   * jumps + 235ms scroll violation" from #55. Optional for back-compat with
   * pre-spawn draft callsites that have no sessionId yet.
   */
  sessionId?: string
  messages: SessionMessage[]
  /**
   * Spec-31 P4b: message-derived gate payload, computed upstream via
   * `useDerivedGate(agentName)`. Supersedes the pre-P4b `(gate, status)`
   * dual signal sourced from `SessionState`. Non-active callers that don't
   * mount `useCodingAgent` pass `null`.
   */
  derivedGate: DerivedGatePayload | null
  isConnecting?: boolean
  onResolveGate: (gateId: string, response: GateResponse) => Promise<unknown>
  readOnly?: boolean
  onRewind?: (turnIndex: number) => void
  branchInfo?: Map<string, { current: number; total: number; siblings: string[] }>
  onBranchNavigate?: (messageId: string, direction: 'prev' | 'next') => void
  onSendSuggestion?: (text: string) => void
}

function renderPart(
  part: SessionMessagePart,
  index: number,
  derivedGate: DerivedGatePayload | null,
  onResolveGate: (gateId: string, response: GateResponse) => Promise<unknown>,
  readOnly?: boolean,
) {
  if (part.type === 'text') {
    return (
      <Message key={index} from="assistant">
        <MessageContent>
          <MessageResponse isAnimating={part.state === 'streaming'}>
            {part.text || ''}
          </MessageResponse>
          {part.state !== 'streaming' && part.text && (
            <div className="flex justify-end">
              <CopyMessageButton text={part.text} />
            </div>
          )}
        </MessageContent>
      </Message>
    )
  }

  // NOTE: `reasoning` parts are intercepted by the assistant-message rendering
  // loop (see ReasoningPillRow usage in the forEach below) and never reach
  // renderPart. The consolidation is what keeps "Thought for a few seconds ×N"
  // from fragmenting into one Reasoning block per thought.

  if (part.type === 'data-file-changed') {
    return (
      <div key={index} className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <FileIcon className="size-3" />
        <span>
          {part.state === 'created' ? 'Created' : 'Modified'}{' '}
          <code className="rounded bg-muted px-1">{part.text || 'unknown'}</code>
        </span>
      </div>
    )
  }

  // Gate parts (ask_user, permission) that are still pending.
  // Render from the part itself rather than transient session state so the
  // GateResolver survives reconnects, tab refocus, and cache-first hydration.
  // The server validates the gateId on resolveGate (returns stale-gate error
  // if the gate moved on), and once resolved the part state transitions away
  // from 'approval-requested' via broadcastMessage so this stops rendering.
  if (isPendingGate(part, readOnly, derivedGate) && part.toolCallId) {
    // Reconstruct the gate payload from the persisted part — the derived
    // gate lookup already matched by toolCallId, so the part IS the
    // authoritative source. No live SessionState.gate merge needed.
    const resolvedGate =
      part.type === 'tool-ask_user'
        ? {
            id: part.toolCallId,
            type: 'ask_user' as const,
            detail: part.input,
          }
        : {
            id: part.toolCallId,
            type: 'permission_request' as const,
            detail: part.input,
          }
    return <GateResolver key={index} gate={resolvedGate} onResolve={onResolveGate} />
  }

  // Resolved ask_user — the part itself is the canonical Q/A record (input
  // holds the question(s), output holds the answer). Render as a
  // conversational block, not as a Tool with a JSON dump — the raw
  // structured-question blob was a meaningless artifact in history.
  if (part.type === 'tool-ask_user') {
    return <ResolvedAskUser key={index} part={part} />
  }

  // Resolved permission — keep a Tool block for the audit trail, but don't
  // force it open; a resolved approval doesn't need its JSON re-expanded
  // every render.
  if (part.type === 'tool-permission') {
    const state = (part.state as ToolHeaderProps['state']) ?? 'output-available'
    return (
      <Tool key={index}>
        <ToolHeader
          {...({
            type: 'dynamic-tool',
            toolName: part.toolName || (part.type || '').replace('tool-', ''),
            state,
          } as ToolHeaderProps)}
        />
        <ToolContent>
          <ToolInput input={part.input} />
          {(state === 'output-available' || state === 'output-error') && (
            <ToolOutput
              output={part.output}
              errorText={state === 'output-error' ? String(part.output ?? 'Error') : undefined}
            />
          )}
        </ToolContent>
      </Tool>
    )
  }

  // Tool parts (other, non-gate)
  if (part.type?.startsWith('tool-')) {
    const state = (part.state as ToolHeaderProps['state']) ?? 'input-available'
    return (
      <Tool key={index}>
        <ToolHeader
          {...({
            type: 'dynamic-tool',
            toolName: part.toolName || part.type.replace('tool-', ''),
            state,
          } as ToolHeaderProps)}
        />
        <ToolContent>
          <ToolInput input={part.input} />
          {(state === 'output-available' || state === 'output-error') && (
            <ToolOutput
              output={part.output}
              errorText={state === 'output-error' ? String(part.output ?? 'Error') : undefined}
            />
          )}
        </ToolContent>
      </Tool>
    )
  }

  // Unknown part type — skip (forward-compatible)
  return null
}

/**
 * Props passed to the memoized per-message row. Kept as stable/primitive
 * references so React.memo's shallow compare only returns false when the
 * message's identity, parts-length, or trailing text length changes.
 */
interface ChatMessageRowProps {
  msg: SessionMessage
  turnIndex: number
  derivedGate: DerivedGatePayload | null
  readOnly?: boolean
  onResolveGate: (gateId: string, response: GateResponse) => Promise<unknown>
  onRewind?: (turnIndex: number) => void
  branch?: { current: number; total: number; siblings: string[] }
  onBranchNavigate?: (messageId: string, direction: 'prev' | 'next') => void
}

/**
 * Memoized renderer for a single message turn (user or assistant).
 *
 * Performance invariants:
 *  - Wrapped in `React.memo` with a custom comparator that checks `msg.id`,
 *    `msg.parts.length`, and the trailing part's `text.length` — the three
 *    signals that actually move during a streaming turn.
 *  - Inline closures for `onRewind(turnIndex)` / `onBranchNavigate(msg.id, _)`
 *    are materialised via `useCallback` so they don't invalidate children
 *    on every parent render.
 *  - Assistant-message rendering hoists `nodes` / `pending` / `reasoningBuf`
 *    inside a `useMemo` keyed on the same shallow-compare tuple so the
 *    flush-and-emit loop only re-runs when something actually changed.
 */
const ChatMessageRow = memo(
  function ChatMessageRow({
    msg,
    turnIndex,
    derivedGate,
    readOnly,
    onResolveGate,
    onRewind,
    branch,
    onBranchNavigate,
  }: ChatMessageRowProps) {
    const handleRewind = useCallback(() => {
      onRewind?.(turnIndex)
    }, [onRewind, turnIndex])

    const handleBranchNavigate = useCallback(
      (dir: 'prev' | 'next') => {
        onBranchNavigate?.(msg.id, dir)
      },
      [onBranchNavigate, msg.id],
    )

    const rewindButton = onRewind ? (
      <button
        key={`rewind-${msg.id}`}
        type="button"
        onClick={handleRewind}
        aria-label="Rewind to this turn"
        title="Rewind to this point"
        data-testid={`rewind-turn-${turnIndex}`}
        className="absolute right-2 top-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
      >
        <HistoryIcon className="size-3" />
        <span>Rewind</span>
      </button>
    ) : null

    // Assistant-message grouping: consolidate reasoning + tool parts into
    // chip rows and intersperse them with text / gate parts. Memoised so a
    // parent re-render that doesn't change the message shape doesn't
    // re-run the flush loop or re-allocate `nodes`.
    const assistantNodes = useMemo(() => {
      if (msg.role !== 'assistant') return null
      const nodes: ReactNode[] = []
      let pending: SessionMessagePart[] = []
      let reasoningBuf: SessionMessagePart[] = []
      const flushReasoning = () => {
        if (reasoningBuf.length === 0) return
        nodes.push(
          <ReasoningPillRow key={`thoughts-${msg.id}-${nodes.length}`} parts={reasoningBuf} />,
        )
        reasoningBuf = []
      }
      const flushPending = () => {
        if (pending.length === 0) return
        nodes.push(<ToolPillRow key={`pills-${msg.id}-${nodes.length}`} parts={pending} />)
        pending = []
      }
      msg.parts.forEach((part, i) => {
        const isGroupableTool =
          part.type?.startsWith('tool-') &&
          !isGateCandidate(part) &&
          !isPendingGate(part, readOnly, derivedGate)
        if (isGroupableTool) {
          pending.push(part)
          return
        }
        if (part.type === 'data-file-changed') return
        if (part.type === 'reasoning') {
          reasoningBuf.push(part)
          return
        }
        flushReasoning()
        flushPending()
        nodes.push(renderPart(part, i, derivedGate, onResolveGate, readOnly))
      })
      flushReasoning()
      flushPending()
      return nodes
    }, [msg, derivedGate, onResolveGate, readOnly])

    if (msg.role === 'user') {
      const textPart = msg.parts.find((p) => p.type === 'text')
      const imageParts = msg.parts.flatMap((p) => {
        const url = getImagePartDataUrl(p)
        return url ? [{ part: p, url }] : []
      })
      return (
        <div key={msg.id} className="group relative" data-turn-index={turnIndex}>
          <Message from="user">
            <MessageContent>
              <div className="flex min-w-0 flex-col gap-2">
                {imageParts.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {imageParts.map(({ url }, i) => (
                      <img
                        // biome-ignore lint/suspicious/noArrayIndexKey: images share no stable id; order is fixed
                        key={i}
                        src={url}
                        alt="User attachment"
                        className="max-h-64 max-w-full rounded border object-contain"
                      />
                    ))}
                  </div>
                )}
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0 break-words">{textPart?.text || ''}</span>
                  {branch && onBranchNavigate && (
                    <MessageBranch
                      current={branch.current}
                      total={branch.total}
                      onNavigate={handleBranchNavigate}
                    />
                  )}
                </div>
              </div>
            </MessageContent>
          </Message>
          {rewindButton}
        </div>
      )
    }

    if (msg.role === 'assistant') {
      return (
        <div key={msg.id} className="group relative" data-turn-index={turnIndex}>
          <div className="space-y-2">{assistantNodes}</div>
          {rewindButton}
        </div>
      )
    }

    return null
  },
  (prev, next) => {
    // Fast-path bailouts: if any non-msg prop changes we must re-render. The
    // comparator only returns true (i.e. "skip re-render") when every input
    // is referentially equal AND the message shape signals we care about
    // are unchanged.
    if (
      prev.turnIndex !== next.turnIndex ||
      prev.derivedGate !== next.derivedGate ||
      prev.readOnly !== next.readOnly ||
      prev.onResolveGate !== next.onResolveGate ||
      prev.onRewind !== next.onRewind ||
      prev.branch !== next.branch ||
      prev.onBranchNavigate !== next.onBranchNavigate
    ) {
      return false
    }
    const a = prev.msg
    const b = next.msg
    if (a === b) return true
    if (a.id !== b.id) return false
    if (a.role !== b.role) return false
    const aParts = a.parts
    const bParts = b.parts
    if (aParts.length !== bParts.length) return false
    const aLast = aParts[aParts.length - 1]
    const bLast = bParts[bParts.length - 1]
    if (!aLast || !bLast) return aLast === bLast
    // Streaming deltas mutate the trailing part's text; catch that without
    // deep-comparing the whole parts array.
    const aText = typeof aLast.text === 'string' ? aLast.text.length : 0
    const bText = typeof bLast.text === 'string' ? bLast.text.length : 0
    if (aText !== bText) return false
    if (aLast.state !== bLast.state) return false
    if (aLast.type !== bLast.type) return false
    return true
  },
)

export function ChatThread({
  sessionId,
  messages,
  derivedGate,
  isConnecting,
  onResolveGate,
  readOnly,
  onRewind,
  branchInfo,
  onBranchNavigate,
  onSendSuggestion,
}: ChatThreadProps) {
  // Empty / connecting placeholder path — bypass the Conversation wrapper
  // entirely. There's no content to auto-scroll and no message list to
  // render, so mounting the IntersectionObserver + ResizeObserver pair would
  // be wasted work.
  if (messages.length === 0) {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" role="log">
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4">
          {isConnecting ? (
            <div className="space-y-6 p-2">
              <div className="flex items-start gap-3">
                <Skeleton className="size-8 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Skeleton className="size-8 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-5/6" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/3" />
                </div>
              </div>
            </div>
          ) : (
            <ConversationEmptyState>
              <div className="space-y-1">
                <h3 className="text-sm font-medium">
                  {onSendSuggestion ? 'Start a conversation' : 'No messages yet'}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {onSendSuggestion
                    ? 'Choose a suggestion or type your own message'
                    : 'The session will appear here as it runs'}
                </p>
              </div>
              {onSendSuggestion && (
                <Suggestions className="mt-4 justify-center">
                  <Suggestion suggestion="Explain this codebase" onClick={onSendSuggestion} />
                  <Suggestion suggestion="Run the test suite" onClick={onSendSuggestion} />
                  <Suggestion suggestion="What changed recently?" onClick={onSendSuggestion} />
                  <Suggestion suggestion="Find and fix bugs" onClick={onSendSuggestion} />
                </Suggestions>
              )}
            </ConversationEmptyState>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip">
      {/*
        `key={sessionId}` is load-bearing. Tabs stay mounted across session
        switches (#51), so without it the same `<Conversation>` instance —
        including its IntersectionObserver (bottom sentinel) and
        ResizeObserver (content-growth pin) — would survive the `messages`
        prop swap and fire against stale baselines from the previous
        session. That was the #55 "6× switch regression on heavy sessions"
        symptom. Keying forces a clean re-init per session; the observers
        are cheap to reconstruct.
      */}
      <Conversation key={sessionId ?? '__no_session__'} className="min-h-0 flex-1">
        <ConversationContent className="[&_pre]:max-w-full [&_pre]:overflow-x-auto">
          {messages.map((msg, index) => (
            <ChatMessageRow
              key={msg.id}
              msg={msg}
              turnIndex={index}
              derivedGate={derivedGate}
              readOnly={readOnly}
              onResolveGate={onResolveGate}
              onRewind={onRewind}
              branch={branchInfo?.get(msg.id)}
              onBranchNavigate={onBranchNavigate}
            />
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  )
}
