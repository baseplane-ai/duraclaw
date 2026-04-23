/**
 * ChatThread — Renders the CodingAgent conversation as a chat thread.
 *
 * Renders SessionMessage parts directly using shared ai-elements components.
 */

import {
  Conversation,
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
  useAutoScrollContext,
} from '@duraclaw/ai-elements'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  BrainIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FileIcon,
  HistoryIcon,
} from 'lucide-react'
import {
  memo,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Badge } from '~/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { Skeleton } from '~/components/ui/skeleton'
import { getImagePartDataUrl, isImageTruncated } from '~/lib/message-parts'
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
// session gate silently renders as a badge instead of the inline
// GateResolver UI.
//
// `tool-AskUserQuestion` is the SDK-native part type emitted the instant the
// assistant calls the AskUserQuestion tool; we treat it as a gate directly
// instead of waiting for the DO's `promoteToolPartToGate` to flip it to
// `tool-ask_user`. That second broadcast can silently drop on a half-closed
// socket (session-do.ts broadcastToClients), which used to leave the gate
// invisible on the active tab until a reconnect refreshed from SQL. Matching
// on the native type removes the dependency on that second frame entirely.
// `tool-ask_user` still matches for back-compat with history rows that were
// persisted under the promoted type.
function isGateCandidate(part: SessionMessagePart): boolean {
  if (!part.toolCallId) return false
  if (
    part.type === 'tool-ask_user' ||
    part.type === 'tool-permission' ||
    part.type === 'tool-AskUserQuestion'
  ) {
    return true
  }
  return false
}

function isPendingGate(part: SessionMessagePart, readOnly: boolean | undefined): boolean {
  if (!isGateCandidate(part) || readOnly) return false
  // The part's own persisted state is the sole signal. The old dual-signal
  // path (part.state + derivedGate pointer) caused flicker when the two
  // disagreed for a single render tick — GateResolver would unmount then
  // remount, losing local form state and producing the "flicker-no-send"
  // symptom. `input-available` is the SDK-native "tool called, awaiting
  // result" state (a pending AskUserQuestion means we're blocking on a
  // human answer); `approval-requested` is the DO-promoted equivalent and
  // is kept for history rows and the permission path.
  return part.state === 'input-available' || part.state === 'approval-requested'
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

/**
 * Extract the structured `answers` array from a resolved ask_user part's
 * `output`, if present. Mirrors the server-side storage shape
 * (`part.output = { answers: StructuredAnswer[] }`). Returns null when the
 * output is a legacy flat string (or absent / malformed).
 */
function parseStructuredAnswers(output: unknown): Array<{ label: string; note?: string }> | null {
  if (!output || typeof output !== 'object') return null
  const obj = output as { answers?: unknown }
  if (!Array.isArray(obj.answers)) return null
  const out: Array<{ label: string; note?: string }> = []
  for (const entry of obj.answers) {
    if (!entry || typeof entry !== 'object') return null
    const e = entry as { label?: unknown; note?: unknown }
    if (typeof e.label !== 'string') return null
    out.push(
      typeof e.note === 'string' && e.note.length > 0
        ? { label: e.label, note: e.note }
        : { label: e.label },
    )
  }
  return out
}

function ResolvedAskUser({ part }: { part: SessionMessagePart }) {
  const questions = parseAskUserQuestions(part.input)
  const denied = part.state === 'output-denied'
  const structuredAnswers = denied ? null : parseStructuredAnswers(part.output)

  // Declined path — preserve existing single-line "Declined" rendering.
  if (denied) {
    return (
      <div className="min-w-0 space-y-1 rounded-lg border-l-2 border-info/30 bg-info/5 p-3">
        {questions.map((q, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: questions share no stable id
          <p key={`q-${i}`} className="break-words text-sm">
            <span className="font-medium text-muted-foreground">Q:</span> {q}
          </p>
        ))}
        <p className="break-words text-sm">
          <span className="font-medium text-muted-foreground">A:</span> Declined
        </p>
      </div>
    )
  }

  // Structured path — pair each question with its answer (and optional
  // note). Two-column layout on sm+ (Q left, A right); stacked on mobile.
  if (structuredAnswers) {
    return (
      <div className="min-w-0 space-y-2 rounded-lg border-l-2 border-info/30 bg-info/5 p-3">
        {questions.map((q, i) => {
          const ans = structuredAnswers[i]
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: questions share no stable id; order matches answers
              key={`qa-${i}`}
              className="flex flex-col gap-1 sm:flex-row sm:gap-4"
            >
              <div className="min-w-0 flex-1 break-words text-sm">
                <span className="font-medium text-muted-foreground">Q:</span> {q}
              </div>
              <div className="min-w-0 flex-1 break-words text-sm">
                <span className="font-medium text-muted-foreground">A:</span> {ans?.label || ''}
                {ans?.note ? (
                  <span className="block text-muted-foreground text-xs">(note: {ans.note})</span>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  // Legacy flat-string path — render questions then a single joined answer
  // at the bottom. Kept for rows persisted before structured `answers`
  // landed.
  const answer =
    typeof part.output === 'string'
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
   * Identity of the session whose messages we render. Currently only used
   * for diagnostics (e.g. `data-session-id` attributes); `AgentOrchPage`
   * already wraps this subtree in `key={activeSessionId}` so `<Conversation>`
   * and the virtualizer always remount on session switch. Kept optional for
   * pre-spawn draft callsites that have no sessionId yet.
   */
  sessionId?: string
  messages: SessionMessage[]
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
  if (isPendingGate(part, readOnly) && part.toolCallId) {
    const resolvedGate =
      part.type === 'tool-ask_user' || part.type === 'tool-AskUserQuestion'
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
    // Stable key: toolCallId is unique per gate invocation. Using array
    // index caused remounts when preceding parts shifted, destroying the
    // GateResolver's local form state (answer text, selections).
    return (
      <GateResolver key={`gate-${part.toolCallId}`} gate={resolvedGate} onResolve={onResolveGate} />
    )
  }

  // Resolved ask_user — the part itself is the canonical Q/A record (input
  // holds the question(s), output holds the answer). Render as a
  // conversational block, not as a Tool with a JSON dump — the raw
  // structured-question blob was a meaningless artifact in history.
  // Matches both the DO-promoted `tool-ask_user` (legacy history rows) and
  // the SDK-native `tool-AskUserQuestion` (new direct-render path).
  if (part.type === 'tool-ask_user' || part.type === 'tool-AskUserQuestion') {
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
      // Bug #63 D: pending-gate nodes are hoisted to the end of the turn
      // rather than rendered in-flow. Without this, if reasoning / text /
      // other tool parts were emitted AFTER the gate in the same
      // assistant turn (e.g. because `promoteToolPartToGate` flipped the
      // gate part at its original index), the gate renders mid-turn
      // instead of at the bottom where the user's attention is.
      // Resolved gates (tool-ask_user / tool-permission with non-pending
      // state) still render inline at their natural position so history
      // shows the Q/A at the point the agent asked.
      let pendingGate: ReactNode | null = null
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
          part.type?.startsWith('tool-') && !isGateCandidate(part) && !isPendingGate(part, readOnly)
        if (isGroupableTool) {
          pending.push(part)
          return
        }
        if (part.type === 'data-file-changed') return
        if (part.type === 'reasoning') {
          reasoningBuf.push(part)
          return
        }
        // Capture pending gate separately so it can be appended after the
        // loop, regardless of where it appeared in `msg.parts`.
        if (isPendingGate(part, readOnly)) {
          pendingGate = renderPart(part, i, onResolveGate, readOnly)
          return
        }
        flushReasoning()
        flushPending()
        nodes.push(renderPart(part, i, onResolveGate, readOnly))
      })
      flushReasoning()
      flushPending()
      if (pendingGate) nodes.push(pendingGate)
      return nodes
    }, [msg, onResolveGate, readOnly])

    if (msg.role === 'user') {
      const textPart = msg.parts.find((p) => p.type === 'text')
      const imageParts = msg.parts.flatMap((p) => {
        if (isImageTruncated(p)) return [{ part: p, url: null as string | null, truncated: true }]
        const url = getImagePartDataUrl(p)
        return url ? [{ part: p, url, truncated: false }] : []
      })
      return (
        <div key={msg.id} className="group relative" data-turn-index={turnIndex}>
          <Message from="user">
            <MessageContent>
              <div className="flex min-w-0 flex-col gap-2">
                {imageParts.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {imageParts.map(({ url, truncated }, i) =>
                      truncated ? (
                        <div
                          // biome-ignore lint/suspicious/noArrayIndexKey: images share no stable id; order is fixed
                          key={i}
                          className="flex h-24 w-40 items-center justify-center rounded border border-dashed border-muted-foreground/30 bg-muted/50 text-xs text-muted-foreground"
                        >
                          Image too large to store
                        </div>
                      ) : (
                        <img
                          // biome-ignore lint/suspicious/noArrayIndexKey: images share no stable id; order is fixed
                          key={i}
                          src={url as string}
                          alt="User attachment"
                          className="max-h-64 max-w-full rounded border object-contain"
                        />
                      ),
                    )}
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
    // Full-parts scan: the trailing-part fast-path above catches streaming
    // text deltas cheaply, but it misses in-place mutations to interior
    // parts — e.g. `promoteToolPartToGate` flipping part[N-2] from
    // `tool-AskUserQuestion`/`input-available` to `tool-ask_user`/
    // `approval-requested` while the trailing text part is untouched. Bug
    // #63 A: without this scan the memo returns true and the gate stays
    // invisible until a refresh. N is small in practice (a turn typically
    // has a handful of parts) and this only runs when length matches.
    for (let i = 0; i < aParts.length; i++) {
      const ap = aParts[i]
      const bp = bParts[i]
      if (ap === bp) continue
      if (!ap || !bp) return false
      if (ap.type !== bp.type) return false
      if (ap.state !== bp.state) return false
      if (ap.toolCallId !== bp.toolCallId) return false
    }
    return true
  },
)

// -------------------------------------------------------------------------
// Virtualized message list. Replaces `<ConversationContent>`'s full-DOM
// render so a 500-message thread mounts ~20 rows (viewport + overscan)
// instead of 500 on every session switch. Wired into the existing
// `<Conversation>` auto-scroll context via `useAutoScrollContext()`:
//   - `scrollRef` → the virtualizer's scroll element (IO root).
//   - `contentRef` → the sized inner div (RO target, height = totalSize).
// Items are absolutely positioned via `translateY(item.start)`. Real row
// heights replace the estimate as rows paint via `measureElement`.
// -------------------------------------------------------------------------

interface VirtualizedMessageListProps {
  messages: SessionMessage[]
  readOnly?: boolean
  onResolveGate: (gateId: string, response: GateResponse) => Promise<unknown>
  onRewind?: (turnIndex: number) => void
  branchInfo?: Map<string, { current: number; total: number; siblings: string[] }>
  onBranchNavigate?: (messageId: string, direction: 'prev' | 'next') => void
}

// Hard cap on the settle window — if the virtualizer hasn't converged in
// this many ms we reveal anyway so a pathological thread doesn't stay
// invisible forever. 100ms is well above any realistic settle on
// modern hardware (typically ~16–32ms = 1–2 rAFs).
const SETTLE_FALLBACK_MS = 100

function VirtualizedMessageList({
  messages,
  readOnly,
  onResolveGate,
  onRewind,
  branchInfo,
  onBranchNavigate,
}: VirtualizedMessageListProps) {
  const { scrollRef, contentRef } = useAutoScrollContext()
  const scrollElRef = useRef<HTMLDivElement | null>(null)

  // Composite ref callback — stashes the node for the virtualizer AND
  // forwards to `<Conversation>`'s scroll-element ref so the IO root is
  // the same element we're scrolling.
  const setScrollEl = useCallback(
    (node: HTMLDivElement | null) => {
      scrollElRef.current = node
      scrollRef(node)
    },
    [scrollRef],
  )

  const getItemKey = useCallback(
    (index: number) => messages[index]?.id ?? `idx-${index}`,
    [messages],
  )

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollElRef.current,
    // 160px is a ballpark "short text turn" estimate. measureElement
    // replaces it with the real height as each row paints. The
    // visibility gate below hides the list until `scrollHeight` is
    // stable, so the estimate→measurement swap is invisible to the
    // user.
    estimateSize: () => 160,
    overscan: 6,
    getItemKey,
    // Top / bottom breathing room around the list (previously the
    // `p-4` on <ConversationContent>).
    paddingStart: 16,
    paddingEnd: 16,
    // 32px inter-row gap (previously `gap-8` on <ConversationContent>).
    gap: 32,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  // --------------------------------------------------------------------
  // Settle gate — hide the list until the virtualizer's `scrollHeight`
  // is stable for two consecutive rAFs, then reveal.
  //
  // The virtualizer's estimate→measurement cycle (rows render at 160px
  // estimates on paint #1, `measureElement` fires, real heights replace
  // the estimates, rows reposition on paint #2) is the source of the
  // visible "fast text shift like a rerender with slightly different
  // positions" jitter on every mount — including the first mount after
  // a hard reload, which no in-memory cache can fix.
  //
  // `visibility: hidden` still lets the virtualizer mount rows and
  // `measureElement` fire; only paint is suppressed, so the settle
  // completes while the user sees nothing, and reveal shows the final
  // layout directly.
  //
  // Mount-only effect: after settle we NEVER re-hide. Streaming deltas,
  // new turns, branch navigation all proceed visibly — otherwise every
  // `partial_assistant` tick would flicker the whole chat.
  // --------------------------------------------------------------------
  const [isSettled, setIsSettled] = useState(false)
  useLayoutEffect(() => {
    const el = scrollElRef.current
    if (!el) {
      // No scroll element on first layout effect — reveal immediately so
      // we don't lock the empty state invisible.
      setIsSettled(true)
      return
    }
    let lastHeight = 0
    let stableFrames = 0
    let rafId = 0
    const tick = () => {
      const h = el.scrollHeight
      if (h > 0 && h === lastHeight) {
        stableFrames += 1
        if (stableFrames >= 2) {
          setIsSettled(true)
          return
        }
      } else {
        stableFrames = 0
        lastHeight = h
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    const timeoutId = window.setTimeout(() => setIsSettled(true), SETTLE_FALLBACK_MS)
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      window.clearTimeout(timeoutId)
    }
  }, [])

  return (
    <div
      ref={setScrollEl}
      style={{
        height: '100%',
        width: '100%',
        overflowY: 'auto',
        visibility: isSettled ? undefined : 'hidden',
      }}
    >
      <div
        ref={contentRef}
        className="[&_pre]:max-w-full [&_pre]:overflow-x-auto"
        style={{ height: totalSize, width: '100%', position: 'relative' }}
      >
        {virtualItems.map((item) => {
          const msg = messages[item.index]
          if (!msg) return null
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                paddingLeft: 16,
                paddingRight: 16,
                transform: `translateY(${item.start}px)`,
              }}
            >
              <ChatMessageRow
                msg={msg}
                turnIndex={item.index}
                readOnly={readOnly}
                onResolveGate={onResolveGate}
                onRewind={onRewind}
                branch={branchInfo?.get(msg.id)}
                onBranchNavigate={onBranchNavigate}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ChatThread({
  sessionId,
  messages,
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
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip"
      data-session-id={sessionId}
    >
      <Conversation className="min-h-0 flex-1">
        <VirtualizedMessageList
          messages={messages}
          readOnly={readOnly}
          onResolveGate={onResolveGate}
          onRewind={onRewind}
          branchInfo={branchInfo}
          onBranchNavigate={onBranchNavigate}
        />
        <ConversationScrollButton />
      </Conversation>
    </div>
  )
}
