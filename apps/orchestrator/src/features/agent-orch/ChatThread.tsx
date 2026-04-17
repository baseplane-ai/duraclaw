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
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
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
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FileIcon,
  HistoryIcon,
} from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import { Badge } from '~/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { Skeleton } from '~/components/ui/skeleton'
import { getImagePartDataUrl } from '~/lib/message-parts'
import type { GateResponse, SessionMessage, SessionMessagePart, SessionState } from '~/lib/types'
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

function isPendingGate(part: SessionMessagePart, readOnly: boolean | undefined): boolean {
  return (
    (part.type === 'tool-ask_user' || part.type === 'tool-permission') &&
    part.state === 'approval-requested' &&
    !readOnly &&
    !!part.toolCallId
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
  messages: SessionMessage[]
  gate: SessionState['gate']
  status: SessionState['status']
  state: SessionState | null
  isConnecting?: boolean
  onResolveGate: (gateId: string, response: GateResponse) => Promise<unknown>
  readOnly?: boolean
  onQaResolved?: (question: string, answer: string) => void
  onRewind?: (turnIndex: number) => void
  branchInfo?: Map<string, { current: number; total: number; siblings: string[] }>
  onBranchNavigate?: (messageId: string, direction: 'prev' | 'next') => void
  onSendSuggestion?: (text: string) => void
}

function renderPart(
  part: SessionMessagePart,
  index: number,
  gate: SessionState['gate'],
  status: SessionState['status'],
  onResolveGate: (gateId: string, response: GateResponse) => Promise<unknown>,
  readOnly?: boolean,
  onQaResolved?: (question: string, answer: string) => void,
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

  if (part.type === 'reasoning') {
    return (
      <Reasoning key={index} isStreaming={part.state === 'streaming'} defaultOpen={true}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text || ''}</ReasoningContent>
      </Reasoning>
    )
  }

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
  if (
    (part.type === 'tool-ask_user' || part.type === 'tool-permission') &&
    part.state === 'approval-requested' &&
    !readOnly &&
    part.toolCallId
  ) {
    const partGate =
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
    // Prefer live gate object when status matches (preserves any server-side
    // detail enrichment), otherwise reconstruct from the persisted part.
    const resolvedGate =
      gate && status === 'waiting_gate' && gate.id === part.toolCallId ? gate : partGate
    return (
      <GateResolver
        key={index}
        gate={resolvedGate}
        onResolve={onResolveGate}
        onResolved={onQaResolved}
      />
    )
  }

  // Tool parts (including resolved gates)
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

export function ChatThread({
  messages,
  gate,
  status,
  state: _state,
  isConnecting,
  onResolveGate,
  readOnly,
  onQaResolved,
  onRewind,
  branchInfo,
  onBranchNavigate,
  onSendSuggestion,
}: ChatThreadProps) {
  return (
    <Conversation className="min-h-0 min-w-0 flex-1 overflow-x-clip">
      <ConversationContent className="min-w-0 overflow-x-hidden [&_pre]:overflow-x-auto [&_pre]:max-w-full">
        {messages.length === 0 && isConnecting ? (
          <div className="space-y-6 p-6">
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
        ) : messages.length === 0 ? (
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
        ) : (
          messages.map((msg, turnIndex) => {
            const rewindButton = onRewind ? (
              <button
                key={`rewind-${msg.id}`}
                type="button"
                onClick={() => onRewind(turnIndex)}
                aria-label="Rewind to this turn"
                title="Rewind to this point"
                data-testid={`rewind-turn-${turnIndex}`}
                className="absolute right-2 top-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
              >
                <HistoryIcon className="size-3" />
                <span>Rewind</span>
              </button>
            ) : null

            if (msg.role === 'qa_pair') {
              const textPart = msg.parts.find((p) => p.type === 'text')
              return (
                <div key={msg.id} className="group relative" data-turn-index={turnIndex}>
                  <div className="min-w-0 space-y-1 rounded-lg border-l-2 border-info/30 bg-info/5 p-3">
                    <p className="break-words text-sm">{textPart?.text || ''}</p>
                  </div>
                  {rewindButton}
                </div>
              )
            }

            if (msg.role === 'user') {
              const textPart = msg.parts.find((p) => p.type === 'text')
              const imageParts = msg.parts.flatMap((p) => {
                const url = getImagePartDataUrl(p)
                return url ? [{ part: p, url }] : []
              })
              const branch = branchInfo?.get(msg.id)
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
                              onNavigate={(dir) => onBranchNavigate(msg.id, dir)}
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
              const nodes: ReactNode[] = []
              let pending: SessionMessagePart[] = []
              const flushPending = () => {
                if (pending.length === 0) return
                nodes.push(<ToolPillRow key={`pills-${msg.id}-${nodes.length}`} parts={pending} />)
                pending = []
              }
              msg.parts.forEach((part, i) => {
                const isGroupableTool =
                  part.type?.startsWith('tool-') && !isPendingGate(part, readOnly)
                if (isGroupableTool) {
                  pending.push(part)
                  return
                }
                // data-file-changed narration rows are redundant with the tool
                // pills (which already group by file path in the detail sheet).
                // Skip without flushing so they don't fragment the chip run.
                if (part.type === 'data-file-changed') return
                flushPending()
                nodes.push(renderPart(part, i, gate, status, onResolveGate, readOnly, onQaResolved))
              })
              flushPending()
              return (
                <div key={msg.id} className="group relative" data-turn-index={turnIndex}>
                  <div className="space-y-2">{nodes}</div>
                  {rewindButton}
                </div>
              )
            }

            return null
          })
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}
