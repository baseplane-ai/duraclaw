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
  Tool,
  ToolContent,
  ToolHeader,
  type ToolHeaderProps,
  ToolInput,
  ToolOutput,
} from '@duraclaw/ai-elements'
import { ChevronLeftIcon, ChevronRightIcon, FileIcon, HistoryIcon } from 'lucide-react'
import { Skeleton } from '~/components/ui/skeleton'
import type { GateResponse, SessionMessage, SessionMessagePart, SessionState } from '~/lib/types'
import { GateResolver } from './GateResolver'

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

  // Gate parts (ask_user, permission) that are still pending
  if (
    (part.type === 'tool-ask_user' || part.type === 'tool-permission') &&
    part.state === 'approval-requested' &&
    !readOnly &&
    gate &&
    status === 'waiting_gate'
  ) {
    return (
      <GateResolver key={index} gate={gate} onResolve={onResolveGate} onResolved={onQaResolved} />
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
}: ChatThreadProps) {
  return (
    <Conversation className="min-h-0 flex-1">
      <ConversationContent>
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
          <ConversationEmptyState
            title="No messages yet"
            description="The session will appear here as it runs"
          />
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
                  <div className="space-y-1 rounded-lg border-l-2 border-blue-500/30 bg-blue-500/5 p-3">
                    <p className="text-sm">{textPart?.text || ''}</p>
                  </div>
                  {rewindButton}
                </div>
              )
            }

            if (msg.role === 'user') {
              const textPart = msg.parts.find((p) => p.type === 'text')
              const branch = branchInfo?.get(msg.id)
              return (
                <div key={msg.id} className="group relative" data-turn-index={turnIndex}>
                  <Message from="user">
                    <MessageContent>
                      <div className="flex items-start justify-between gap-2">
                        <span>{textPart?.text || ''}</span>
                        {branch && onBranchNavigate && (
                          <MessageBranch
                            current={branch.current}
                            total={branch.total}
                            onNavigate={(dir) => onBranchNavigate(msg.id, dir)}
                          />
                        )}
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
                  <div className="space-y-2">
                    {msg.parts.map((part, i) =>
                      renderPart(part, i, gate, status, onResolveGate, readOnly, onQaResolved),
                    )}
                  </div>
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
