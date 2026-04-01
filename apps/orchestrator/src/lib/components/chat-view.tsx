import { useState, useEffect, useCallback, useMemo } from 'react'
import { useChat } from '@ai-sdk/react'
import { useAgent } from 'agents/react'
import { Badge, Button, Card, CardContent, Input, Skeleton, Textarea } from './ui'
import type { SessionState, StoredMessage } from '~/lib/types'
import type { UIMessage } from 'ai'
import { WsChatTransport } from '~/lib/ws-chat-transport'
import { storedToUIMessages } from '~/lib/stored-to-ui-messages'
import { TextPart } from './message-parts/text-part'
import { ToolPart } from './message-parts/tool-part'
import { ReasoningPart } from './message-parts/reasoning-part'

// ── Message Bubble ──────────────────────────────────────────────────

function MessageBubble({
  message,
  onToolApprove,
  onToolDeny,
}: {
  message: UIMessage
  onToolApprove: (toolCallId: string) => void
  onToolDeny: (toolCallId: string) => void
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-primary text-primary-foreground p-3">
          {message.parts.map((part, i) => {
            if (part.type === 'text') return <p key={i} className="text-sm whitespace-pre-wrap">{part.text}</p>
            return null
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg bg-card border border-border p-4">
      <div className="text-xs font-medium text-muted-foreground mb-2">Assistant</div>
      <div className="space-y-3">
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            return <TextPart key={i} text={part.text} streaming={part.state === 'streaming'} />
          }
          if (part.type === 'reasoning') {
            return <ReasoningPart key={i} text={part.text} streaming={part.state === 'streaming'} />
          }
          if ('toolCallId' in part && 'toolName' in part) {
            const p = part as any
            return (
              <ToolPart
                key={i}
                toolName={p.toolName}
                toolCallId={p.toolCallId}
                state={p.state}
                input={p.input}
                output={p.output}
                errorText={p.errorText}
                onApprove={onToolApprove}
                onDeny={onToolDeny}
              />
            )
          }
          return null
        })}
      </div>
    </div>
  )
}

// ── Question Prompt ─────────────────────────────────────────────────

function QuestionPrompt({
  questions,
  onSubmit,
}: {
  questions: Array<{ id: string; text: string }>
  onSubmit: (answers: Record<string, string>) => void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})

  return (
    <Card className="border-warning/50">
      <CardContent className="p-4">
        <div className="mb-3">
          <Badge variant="warning">Question</Badge>
        </div>
        <div className="space-y-3">
          {questions.map((q) => (
            <div key={q.id}>
              <label className="mb-1 block text-sm">{q.text}</label>
              <Input
                value={answers[q.id] ?? ''}
                onChange={(e) =>
                  setAnswers({
                    ...answers,
                    [q.id]: (e.target as unknown as { value: string }).value,
                  })
                }
                placeholder="Your answer..."
              />
            </div>
          ))}
        </div>
        <Button size="sm" className="mt-3" onClick={() => onSubmit(answers)}>
          Submit Answers
        </Button>
      </CardContent>
    </Card>
  )
}

// ── Prompt Input ────────────────────────────────────────────────────

function PromptInput({
  onSend,
  disabled,
}: {
  onSend: (content: string) => void
  disabled: boolean
}) {
  const [value, setValue] = useState('')

  function handleSubmit() {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setValue('')
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="border-t border-border p-4">
      <div className="flex gap-2">
        <Textarea
          value={value}
          onChange={(e) =>
            setValue((e.target as unknown as { value: string }).value)
          }
          onKeyDown={handleKeyDown}
          placeholder={
            disabled
              ? 'Session is not running...'
              : 'Send a message... (Ctrl+Enter)'
          }
          disabled={disabled}
          rows={2}
          className="flex-1 resize-none"
        />
        <Button
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          className="self-end"
        >
          Send
        </Button>
      </div>
    </div>
  )
}

// ── Session Header ──────────────────────────────────────────────────

function SessionHeader({
  session,
  onAbort,
}: {
  session: SessionState | null
  onAbort: () => void
}) {
  if (!session) return <Skeleton className="h-12" />

  const isActive = ['running', 'waiting_input', 'waiting_permission'].includes(
    session.status,
  )

  return (
    <header className="flex items-center justify-between border-b border-border px-4 py-3">
      <div className="flex items-center gap-3">
        <a
          href="/"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          &larr; Dashboard
        </a>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium">{session.project}</span>
        <StatusBadge status={session.status} />
        {session.model && (
          <Badge variant="outline" className="text-xs">
            {session.model}
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-3">
        {session.duration_ms != null && (
          <span className="text-xs text-muted-foreground">
            {formatDuration(session.duration_ms)}
          </span>
        )}
        {session.total_cost_usd != null && (
          <span className="text-xs text-muted-foreground">
            ${session.total_cost_usd.toFixed(4)}
          </span>
        )}
        {isActive && (
          <Button size="sm" variant="destructive" onClick={onAbort}>
            Abort
          </Button>
        )}
      </div>
    </header>
  )
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<
    string,
    {
      variant:
        | 'default'
        | 'success'
        | 'warning'
        | 'destructive'
        | 'secondary'
        | 'outline'
      label: string
    }
  > = {
    running: { variant: 'success', label: 'Running' },
    waiting_input: { variant: 'warning', label: 'Waiting' },
    waiting_permission: { variant: 'warning', label: 'Permission' },
    completed: { variant: 'secondary', label: 'Completed' },
    failed: { variant: 'destructive', label: 'Failed' },
    aborted: { variant: 'outline', label: 'Aborted' },
    idle: { variant: 'outline', label: 'Idle' },
  }
  const v = variants[status] ?? { variant: 'outline' as const, label: status }
  return <Badge variant={v.variant}>{v.label}</Badge>
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remainSecs = secs % 60
  return `${mins}m ${remainSecs}s`
}

// ── Main Chat View ──────────────────────────────────────────────────

export function ChatView({ sessionId }: { sessionId: string }) {
  // Connection 1: Real-time state sync via PartySocket
  const [session, setSession] = useState<SessionState | null>(null)
  const agent = useAgent<SessionState>({
    agent: 'session-do',
    name: sessionId,
    basePath: `/api/sessions/${sessionId}/agent`,
    onStateUpdate: (state) => setSession(state),
  })

  // Connection 2: Chat message streaming via AI SDK
  const transport = useMemo(() => new WsChatTransport(sessionId), [sessionId])
  const {
    messages,
    sendMessage,
    status: chatStatus,
    setMessages,
    addToolApprovalResponse,
  } = useChat({
    id: sessionId,
    transport,
  })

  // Load stored message history on mount
  useEffect(() => {
    fetch(`/api/sessions/${sessionId}/messages`)
      .then((r) => r.json())
      .then((data: unknown) => {
        const stored = (data as { messages?: StoredMessage[] }).messages ?? []
        const uiMessages = storedToUIMessages(stored)
        if (uiMessages.length > 0) {
          setMessages(uiMessages)
        }
      })
      .catch(() => {})
  }, [sessionId, setMessages])

  // Tool approval handler — goes through both useChat (local) and agent RPC (server)
  const handleToolApproval = useCallback(
    (toolCallId: string, approved: boolean) => {
      // Update local UI state (AI SDK uses 'id' for the approval ID)
      addToolApprovalResponse({ id: toolCallId, approved })
      // Send to server via agent RPC
      agent.call('submitToolApproval', [{ toolCallId, approved }])
    },
    [addToolApprovalResponse, agent],
  )

  // Question answer handler — via agent RPC
  const handleQuestionAnswer = useCallback(
    (answers: Record<string, string>) => {
      if (!session?.pending_question) return
      // The toolCallId for pending questions is stored in state
      agent.call('submitAnswers', [{ toolCallId: 'pending-question', answers }])
    },
    [agent, session?.pending_question],
  )

  const handleAbort = useCallback(() => {
    if ((globalThis as unknown as { confirm: (msg: string) => boolean }).confirm('Are you sure you want to abort this session?')) {
      fetch(`/api/sessions/${sessionId}/abort`, { method: 'POST' }).catch(
        () => {},
      )
    }
  }, [sessionId])

  const isActive = session
    ? ['running', 'waiting_input', 'idle'].includes(session.status)
    : false

  const isStreaming = chatStatus === 'streaming' || chatStatus === 'submitted'

  return (
    <div className="flex h-screen flex-col">
      <SessionHeader session={session} onAbort={handleAbort} />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onToolApprove={(id) => handleToolApproval(id, true)}
            onToolDeny={(id) => handleToolApproval(id, false)}
          />
        ))}
      </div>

      {/* Pending question from agent state */}
      {session?.pending_question && session.status === 'waiting_input' && (
        <div className="px-4 pb-2">
          <QuestionPrompt
            questions={
              session.pending_question as Array<{ id: string; text: string }>
            }
            onSubmit={handleQuestionAnswer}
          />
        </div>
      )}

      <PromptInput
        onSend={(text) => sendMessage({ text })}
        disabled={!isActive || isStreaming}
      />
    </div>
  )
}
