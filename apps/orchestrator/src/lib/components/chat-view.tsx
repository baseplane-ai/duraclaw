import { useState, useEffect, useRef, useCallback } from 'react'
import { Badge, Button, Card, CardContent, Input, Skeleton, Textarea } from './ui'
import { cn } from '~/lib/utils'
import type { SessionState, StoredMessage, UIStreamChunk } from '~/lib/types'
import { WebSocketChatTransport } from '~/lib/ws-transport'

// -- Message Types for Display -----------------------------------------------

interface DisplayMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  toolCallId?: string
  toolInput?: string
  toolOutput?: string
  isStreaming?: boolean
}

// -- Chat Messages Component -------------------------------------------------

function ChatMessages({
  messages,
  streamingText,
  streamingTools,
}: {
  messages: DisplayMessage[]
  streamingText: string
  streamingTools: Map<string, { name: string; input: string; output?: string }>
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current as unknown as { scrollTop: number; scrollHeight: number } | null
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, streamingText, streamingTools])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {/* Streaming text */}
      {streamingText && (
        <div className="rounded-lg bg-card border border-border p-4">
          <div className="text-xs font-medium text-muted-foreground mb-2">Assistant</div>
          <div className="text-sm whitespace-pre-wrap">{streamingText}</div>
          <span className="inline-block w-2 h-4 bg-foreground animate-pulse ml-0.5" />
        </div>
      )}

      {/* Streaming tool calls */}
      {Array.from(streamingTools.entries()).map(([id, tool]) => (
        <ToolCallBlock
          key={id}
          toolCallId={id}
          toolName={tool.name}
          input={tool.input}
          output={tool.output}
        />
      ))}
    </div>
  )
}

function MessageBubble({ message }: { message: DisplayMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-primary text-primary-foreground p-3">
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    )
  }

  if (message.role === 'tool') {
    return (
      <ToolCallBlock
        toolCallId={message.toolCallId ?? ''}
        toolName={message.toolName ?? 'Tool'}
        input={message.toolInput ?? ''}
        output={message.toolOutput}
      />
    )
  }

  return (
    <div className="rounded-lg bg-card border border-border p-4">
      <div className="text-xs font-medium text-muted-foreground mb-2">Assistant</div>
      <div className="text-sm whitespace-pre-wrap">{message.content}</div>
    </div>
  )
}

function ToolCallBlock({
  toolCallId: _toolCallId,
  toolName,
  input,
  output,
}: {
  toolCallId: string
  toolName: string
  input: string
  output?: string
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium bg-muted/50 hover:bg-muted transition-colors"
      >
        <span className={cn('transition-transform', expanded && 'rotate-90')}>
          &#9654;
        </span>
        <Badge variant="outline" className="text-xs">
          {toolName}
        </Badge>
        {output ? (
          <span className="text-success">completed</span>
        ) : (
          <span className="text-warning animate-pulse">running...</span>
        )}
      </button>
      {expanded && (
        <div className="p-3 space-y-2">
          {input && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Input</div>
              <pre className="text-xs bg-muted/30 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">
                {input}
              </pre>
            </div>
          )}
          {output && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Output</div>
              <pre className="text-xs bg-muted/30 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">
                {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// -- Permission/Question UI --------------------------------------------------

function PermissionPrompt({
  toolCallId,
  toolName,
  input,
  onRespond,
}: {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  onRespond: (toolCallId: string, approved: boolean) => void
}) {
  return (
    <Card className="border-warning/50">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Badge variant="warning">Permission Required</Badge>
          <span className="text-sm font-medium">{toolName}</span>
        </div>
        <pre className="text-xs bg-muted/30 rounded p-2 mb-3 overflow-x-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => onRespond(toolCallId, true)}
            className="bg-success hover:bg-success/90 text-white"
          >
            Allow
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => onRespond(toolCallId, false)}
          >
            Deny
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function AskUserPrompt({
  toolCallId,
  questions,
  onSubmit,
}: {
  toolCallId: string
  questions: Array<{ id: string; text: string }>
  onSubmit: (toolCallId: string, answers: Record<string, string>) => void
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
        <Button
          size="sm"
          className="mt-3"
          onClick={() => onSubmit(toolCallId, answers)}
        >
          Submit Answers
        </Button>
      </CardContent>
    </Card>
  )
}

// -- Prompt Input ------------------------------------------------------------

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

// -- Session Header ----------------------------------------------------------

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
        <span className="font-medium">{session.worktree}</span>
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

// -- Main Chat View ----------------------------------------------------------

export function ChatView({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<SessionState | null>(null)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [streamingTools, setStreamingTools] = useState<
    Map<string, { name: string; input: string; output?: string }>
  >(new Map())
  const [pendingPermission, setPendingPermission] = useState<{
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  } | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<{
    toolCallId: string
    questions: Array<{ id: string; text: string }>
  } | null>(null)
  const [connectionState, setConnectionState] = useState<
    'connecting' | 'connected' | 'disconnected'
  >('disconnected')
  const transportRef = useRef<WebSocketChatTransport | null>(null)

  // Load session state
  useEffect(() => {
    fetch(`/api/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((data: unknown) =>
        setSession((data as { session: SessionState }).session),
      )
      .catch(() => {})

    // Poll session state
    const interval = setInterval(() => {
      fetch(`/api/sessions/${sessionId}`)
        .then((r) => r.json())
        .then((data: unknown) =>
          setSession((data as { session: SessionState }).session),
        )
        .catch(() => {})
    }, 3000)
    return () => clearInterval(interval)
  }, [sessionId])

  // Connect WebSocket transport
  useEffect(() => {
    const transport = new WebSocketChatTransport(sessionId)
    transportRef.current = transport

    transport.onStateChange(setConnectionState)

    transport.onChunk((chunk: UIStreamChunk) => {
      switch (chunk.type) {
        case 'history': {
          // Load message history
          const msgs: DisplayMessage[] = (chunk.messages ?? []).map(
            (m: StoredMessage, i: number) => {
              const data = JSON.parse(m.data)
              if (m.role === 'user') {
                return {
                  id: `hist-${i}`,
                  role: 'user' as const,
                  content: (data as { content?: string }).content ?? '',
                }
              }
              if (m.type === 'tool_result') {
                return {
                  id: `hist-${i}`,
                  role: 'tool' as const,
                  content: '',
                  toolCallId: (data as { uuid?: string }).uuid,
                  toolOutput: JSON.stringify(
                    (data as { content?: unknown }).content,
                    null,
                    2,
                  ),
                }
              }
              // assistant
              const blocks = (data as { content?: unknown[] }).content ?? []
              const textContent = blocks
                .filter(
                  (b: unknown) =>
                    (b as { type: string }).type === 'text',
                )
                .map((b: unknown) => (b as { text: string }).text)
                .join('\n')
              return {
                id: `hist-${i}`,
                role: 'assistant' as const,
                content: textContent,
              }
            },
          )
          setMessages(msgs)
          break
        }

        case 'text-delta':
          setStreamingText((prev) => prev + chunk.delta)
          break

        case 'text-start':
          setStreamingText('')
          break

        case 'text-end':
          // Finalize streaming text into a message
          setStreamingText((prev) => {
            if (prev) {
              setMessages((msgs) => [
                ...msgs,
                {
                  id: `msg-${Date.now()}`,
                  role: 'assistant',
                  content: prev,
                },
              ])
            }
            return ''
          })
          break

        case 'tool-input-start':
          setStreamingTools((prev) => {
            const next = new Map(prev)
            next.set(chunk.toolCallId, { name: chunk.toolName, input: '' })
            return next
          })
          break

        case 'tool-input-delta':
          setStreamingTools((prev) => {
            const next = new Map(prev)
            const tool = next.get(chunk.toolCallId)
            if (tool) {
              next.set(chunk.toolCallId, {
                ...tool,
                input: tool.input + chunk.inputTextDelta,
              })
            }
            return next
          })
          break

        case 'tool-input-available':
          if (chunk.toolName === 'AskUserQuestion') {
            setPendingQuestion({
              toolCallId: chunk.toolCallId,
              questions: (
                chunk.input as {
                  questions?: Array<{ id: string; text: string }>
                }
              ).questions ?? [],
            })
          } else {
            setPendingPermission({
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
            })
          }
          break

        case 'tool-output-available':
          setStreamingTools((prev) => {
            const next = new Map(prev)
            const tool = next.get(chunk.toolCallId)
            if (tool) {
              setMessages((msgs) => [
                ...msgs,
                {
                  id: `tool-${chunk.toolCallId}`,
                  role: 'tool',
                  content: '',
                  toolCallId: chunk.toolCallId,
                  toolName: tool.name,
                  toolInput: tool.input,
                  toolOutput:
                    typeof chunk.output === 'string'
                      ? chunk.output
                      : JSON.stringify(chunk.output, null, 2),
                },
              ])
              next.delete(chunk.toolCallId)
            }
            return next
          })
          break

        case 'file-changed':
          // Could show notification - for now just log
          break

        case 'finish':
          setStreamingText('')
          setStreamingTools(new Map())
          break

        case 'turn-complete':
          setStreamingText('')
          setStreamingTools(new Map())
          // Session state will update via polling (3s interval)
          break
      }
    })

    transport.connect()

    return () => {
      transport.disconnect()
      transportRef.current = null
    }
  }, [sessionId])

  const handleSendMessage = useCallback((content: string) => {
    // Add user message optimistically
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: 'user',
        content,
      },
    ])
    transportRef.current?.sendMessage(content)
  }, [])

  const handleAbort = useCallback(() => {
    if ((globalThis as unknown as { confirm: (msg: string) => boolean }).confirm('Are you sure you want to abort this session?')) {
      fetch(`/api/sessions/${sessionId}/abort`, { method: 'POST' }).catch(
        () => {},
      )
    }
  }, [sessionId])

  const handlePermissionResponse = useCallback(
    (toolCallId: string, approved: boolean) => {
      transportRef.current?.sendToolApproval(toolCallId, approved)
      setPendingPermission(null)
    },
    [],
  )

  const handleQuestionAnswer = useCallback(
    (toolCallId: string, answers: Record<string, string>) => {
      transportRef.current?.sendToolApproval(toolCallId, true, answers)
      setPendingQuestion(null)
    },
    [],
  )

  const isActive = session
    ? ['running', 'waiting_input', 'idle'].includes(session.status)
    : false

  return (
    <div className="flex h-screen flex-col">
      <SessionHeader session={session} onAbort={handleAbort} />

      {/* Connection status */}
      {connectionState === 'disconnected' && (
        <div className="bg-destructive/10 border-b border-destructive/20 px-4 py-2 text-xs text-destructive">
          Disconnected from session. Attempting to reconnect...
        </div>
      )}

      <ChatMessages
        messages={messages}
        streamingText={streamingText}
        streamingTools={streamingTools}
      />

      {/* Permission / Question prompts */}
      {pendingPermission && (
        <div className="px-4 pb-2">
          <PermissionPrompt
            toolCallId={pendingPermission.toolCallId}
            toolName={pendingPermission.toolName}
            input={pendingPermission.input}
            onRespond={handlePermissionResponse}
          />
        </div>
      )}

      {pendingQuestion && (
        <div className="px-4 pb-2">
          <AskUserPrompt
            toolCallId={pendingQuestion.toolCallId}
            questions={pendingQuestion.questions}
            onSubmit={handleQuestionAnswer}
          />
        </div>
      )}

      <PromptInput onSend={handleSendMessage} disabled={!isActive} />
    </div>
  )
}
