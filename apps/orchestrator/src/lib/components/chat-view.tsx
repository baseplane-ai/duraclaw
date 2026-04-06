import { useChat } from '@ai-sdk/react'
import type { UIMessage } from 'ai'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { storedToUIMessages } from '~/lib/stored-to-ui-messages'
import type { SessionState } from '~/lib/types'
import { cn } from '~/lib/utils'
import { WsChatTransport } from '~/lib/ws-chat-transport'
import { ReasoningPart } from './message-parts/reasoning-part'
import { TextPart } from './message-parts/text-part'
import { ToolPart } from './message-parts/tool-part'
import { Badge, Button, Card, CardContent, Input, Skeleton, Textarea } from './ui'

type QuestionAnswerValue = string | string[]

export interface QuestionOption {
  description?: string
  label: string
}

export interface NormalizedQuestion {
  defaultValue: QuestionAnswerValue
  header?: string
  id: string
  multiSelect: boolean
  options: QuestionOption[]
  placeholder?: string
  required: boolean
  text: string
  type: 'text' | 'select' | 'confirm'
}

function normalizeOption(option: unknown): QuestionOption | null {
  if (typeof option === 'string') {
    return { label: option }
  }

  if (!option || typeof option !== 'object') {
    return null
  }

  const record = option as { description?: unknown; label?: unknown }
  if (typeof record.label !== 'string' || record.label.length === 0) {
    return null
  }

  return {
    label: record.label,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
  }
}

function inferQuestionType(
  header: string | undefined,
  options: QuestionOption[],
  explicitType: unknown,
): NormalizedQuestion['type'] {
  if (explicitType === 'text' || explicitType === 'select' || explicitType === 'confirm') {
    return explicitType
  }

  if (options.length === 0) {
    return 'text'
  }

  const optionLabels = options.map((option) => option.label.toLowerCase())
  if (
    header?.toLowerCase().includes('confirm') ||
    (optionLabels.length === 2 &&
      optionLabels.some((label) => label.startsWith('yes')) &&
      optionLabels.some((label) => label.startsWith('no')))
  ) {
    return 'confirm'
  }

  return 'select'
}

export function normalizeQuestions(rawQuestions: unknown[]): NormalizedQuestion[] {
  return rawQuestions.map((question, index) => {
    if (typeof question === 'string') {
      return {
        defaultValue: '',
        id: `question-${index}`,
        multiSelect: false,
        options: [],
        required: true,
        text: question,
        type: 'text',
      }
    }

    const record =
      question && typeof question === 'object' ? (question as Record<string, unknown>) : {}
    const options = Array.isArray(record.options)
      ? record.options
          .map(normalizeOption)
          .filter((option): option is QuestionOption => option !== null)
      : []

    const header = typeof record.header === 'string' ? record.header : undefined
    const multiSelect = Boolean(record.multiSelect)
    const defaultValue = Array.isArray(record.default)
      ? record.default.filter((value): value is string => typeof value === 'string')
      : typeof record.default === 'string'
        ? record.default
        : ''

    return {
      defaultValue,
      header,
      id: typeof record.id === 'string' ? record.id : `question-${index}`,
      multiSelect,
      options,
      placeholder: typeof record.placeholder === 'string' ? record.placeholder : undefined,
      required: record.required !== false,
      text:
        typeof record.question === 'string'
          ? record.question
          : typeof record.text === 'string'
            ? record.text
            : `Question ${index + 1}`,
      type: inferQuestionType(header, options, record.type),
    }
  })
}

function isQuestionComplete(question: NormalizedQuestion, value: QuestionAnswerValue | undefined) {
  if (!question.required) return true
  if (Array.isArray(value)) return value.length > 0
  return typeof value === 'string' && value.trim().length > 0
}

function serializeAnswers(
  questions: NormalizedQuestion[],
  answers: Record<string, QuestionAnswerValue>,
): Record<string, string> {
  return Object.fromEntries(
    questions.map((question) => {
      const answer = answers[question.id]
      if (Array.isArray(answer)) {
        return [question.id, answer.join(', ')]
      }

      return [question.id, answer ?? '']
    }),
  )
}

function getLatestAskUserQuestionToolCallId(messages: UIMessage[]): string | null {
  for (const message of [...messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (
        'toolCallId' in part &&
        'toolName' in part &&
        typeof part.toolCallId === 'string' &&
        part.toolName === 'AskUserQuestion'
      ) {
        return part.toolCallId
      }
    }
  }

  return null
}

function MessageBubble({
  message,
  onToolApprove,
  onToolDeny,
}: {
  message: UIMessage
  onToolApprove: (toolCallId: string) => void
  onToolDeny: (toolCallId: string) => void
}) {
  function getPartKey(part: UIMessage['parts'][number]): string {
    if (part.type === 'text' || part.type === 'reasoning') {
      return `${message.id}-${part.type}-${part.text.length}-${part.text.slice(0, 24)}`
    }

    if ('toolCallId' in part && typeof part.toolCallId === 'string') {
      return `${message.id}-tool-${part.toolCallId}`
    }

    return `${message.id}-${part.type}`
  }

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[min(92%,44rem)] rounded-2xl bg-primary p-3 text-primary-foreground sm:p-4">
          {message.parts.map((part) => {
            if (part.type !== 'text') return null

            return (
              <p key={getPartKey(part)} className="whitespace-pre-wrap text-sm leading-6">
                {part.text}
              </p>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-border bg-card/85 p-4 shadow-sm">
      <div className="mb-2 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        Assistant
      </div>
      <div className="space-y-3">
        {message.parts.map((part) => {
          if (part.type === 'text') {
            return (
              <TextPart
                key={getPartKey(part)}
                streaming={part.state === 'streaming'}
                text={part.text}
              />
            )
          }

          if (part.type === 'reasoning') {
            return (
              <ReasoningPart
                key={getPartKey(part)}
                streaming={part.state === 'streaming'}
                text={part.text}
              />
            )
          }

          if ('toolCallId' in part && 'toolName' in part) {
            const dynamicPart = part as any
            return (
              <ToolPart
                key={getPartKey(part)}
                errorText={dynamicPart.errorText}
                input={dynamicPart.input}
                onApprove={onToolApprove}
                onDeny={onToolDeny}
                output={dynamicPart.output}
                state={dynamicPart.state}
                toolCallId={dynamicPart.toolCallId}
                toolName={dynamicPart.toolName}
              />
            )
          }

          return null
        })}
      </div>
    </div>
  )
}

export function QuestionPrompt({
  onSubmit,
  questions,
}: {
  onSubmit: (answers: Record<string, string>) => void
  questions: unknown[]
}) {
  const normalizedQuestions = useMemo(() => normalizeQuestions(questions), [questions])
  const [answers, setAnswers] = useState<Record<string, QuestionAnswerValue>>(() =>
    Object.fromEntries(normalizedQuestions.map((question) => [question.id, question.defaultValue])),
  )
  const [showValidation, setShowValidation] = useState(false)

  useEffect(() => {
    setAnswers(
      Object.fromEntries(
        normalizedQuestions.map((question) => [question.id, question.defaultValue]),
      ),
    )
    setShowValidation(false)
  }, [normalizedQuestions])

  const missingRequired = normalizedQuestions.filter(
    (question) => !isQuestionComplete(question, answers[question.id]),
  )

  function updateAnswer(questionId: string, value: QuestionAnswerValue) {
    setAnswers((current) => ({
      ...current,
      [questionId]: value,
    }))
  }

  function handleSubmit() {
    if (missingRequired.length > 0) {
      setShowValidation(true)
      return
    }

    onSubmit(serializeAnswers(normalizedQuestions, answers))
  }

  return (
    <Card className="border-warning/50 bg-warning/5">
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <Badge variant="warning">Question</Badge>
            <p className="text-sm text-muted-foreground">
              Claude needs input before the session can continue.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {normalizedQuestions.map((question) => {
            const value = answers[question.id]
            const invalid = showValidation && !isQuestionComplete(question, value)
            const labelId = `question-label-${question.id}`
            const inputId = `question-input-${question.id}`

            return (
              <div
                key={question.id}
                className="space-y-3 rounded-2xl border border-border/70 bg-background/60 p-4"
              >
                <div className="space-y-1">
                  {question.header && (
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      {question.header}
                    </p>
                  )}
                  <p className="block text-sm font-medium leading-6" id={labelId}>
                    {question.text}
                  </p>
                </div>

                {question.type === 'text' && (
                  <Input
                    aria-labelledby={labelId}
                    className={cn('min-h-11', invalid && 'border-warning')}
                    data-testid={inputId}
                    id={inputId}
                    onChange={(event) =>
                      updateAnswer(
                        question.id,
                        (event.target as unknown as { value: string }).value,
                      )
                    }
                    placeholder={question.placeholder ?? 'Your answer...'}
                    value={typeof value === 'string' ? value : ''}
                  />
                )}

                {question.type === 'confirm' && (
                  <fieldset
                    aria-labelledby={labelId}
                    className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                  >
                    {question.options.map((option, optionIndex) => {
                      const selected = value === option.label
                      return (
                        <Button
                          key={option.label}
                          className="min-h-11 justify-start whitespace-normal text-left"
                          data-testid={`question-option-${question.id}-${optionIndex}`}
                          onClick={() => updateAnswer(question.id, option.label)}
                          type="button"
                          variant={selected ? 'default' : 'outline'}
                        >
                          <span>
                            <span className="block">{option.label}</span>
                            {option.description && (
                              <span className="mt-0.5 block text-xs opacity-80">
                                {option.description}
                              </span>
                            )}
                          </span>
                        </Button>
                      )
                    })}
                  </fieldset>
                )}

                {question.type === 'select' && !question.multiSelect && (
                  <div aria-labelledby={labelId} className="space-y-2" role="radiogroup">
                    {question.options.map((option, optionIndex) => {
                      const selected = value === option.label
                      return (
                        <button
                          key={option.label}
                          className={cn(
                            'flex min-h-11 w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors',
                            selected
                              ? 'border-primary bg-primary/10'
                              : 'border-border hover:bg-accent/40',
                          )}
                          data-testid={`question-option-${question.id}-${optionIndex}`}
                          onClick={() => updateAnswer(question.id, option.label)}
                          type="button"
                        >
                          <span
                            className={cn(
                              'mt-1 h-4 w-4 shrink-0 rounded-full border',
                              selected ? 'border-primary bg-primary' : 'border-muted-foreground/50',
                            )}
                          />
                          <span>
                            <span className="block text-sm font-medium">{option.label}</span>
                            {option.description && (
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {option.description}
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}

                {question.type === 'select' && question.multiSelect && (
                  <fieldset aria-labelledby={labelId} className="space-y-2">
                    {question.options.map((option, optionIndex) => {
                      const selectedValues = Array.isArray(value) ? value : []
                      const selected = selectedValues.includes(option.label)

                      return (
                        <label
                          key={option.label}
                          className={cn(
                            'flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 transition-colors',
                            selected
                              ? 'border-primary bg-primary/10'
                              : 'border-border hover:bg-accent/40',
                          )}
                        >
                          <input
                            checked={selected}
                            className="mt-1 h-4 w-4"
                            data-testid={`question-option-${question.id}-${optionIndex}`}
                            onChange={(event) => {
                              const next = new Set(selectedValues)
                              if ((event.target as HTMLInputElement).checked) {
                                next.add(option.label)
                              } else {
                                next.delete(option.label)
                              }
                              updateAnswer(question.id, Array.from(next))
                            }}
                            type="checkbox"
                          />
                          <span>
                            <span className="block text-sm font-medium">{option.label}</span>
                            {option.description && (
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {option.description}
                              </span>
                            )}
                          </span>
                        </label>
                      )
                    })}
                  </fieldset>
                )}

                {invalid && (
                  <p className="text-xs text-warning">This answer is required before continuing.</p>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            className="min-h-11"
            data-testid="question-submit"
            onClick={handleSubmit}
            type="button"
          >
            Submit Answers
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function PromptInput({
  disabled,
  onSend,
}: {
  disabled: boolean
  onSend: (content: string) => void
}) {
  const [value, setValue] = useState('')

  function handleSubmit() {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setValue('')
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="border-t border-border bg-background/95 px-4 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-3 backdrop-blur sm:px-6">
      <div className="flex gap-2">
        <Textarea
          className="min-h-[96px] flex-1 resize-none"
          disabled={disabled}
          onChange={(event) => setValue((event.target as unknown as { value: string }).value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? 'Session is not running...' : 'Send a message... (Ctrl+Enter)'}
          rows={3}
          value={value}
        />
        <Button
          className="min-h-11 self-end"
          disabled={disabled || !value.trim()}
          onClick={handleSubmit}
        >
          Send
        </Button>
      </div>
    </div>
  )
}

export function SessionHeader({
  onAbort,
  session,
}: {
  onAbort: () => void
  session: SessionState | null
}) {
  if (!session) {
    return <Skeleton className="h-16 rounded-none" />
  }

  const isActive = ['running', 'waiting_input', 'waiting_permission'].includes(session.status)

  return (
    <header
      className="sticky top-0 z-20 border-b border-border bg-background/95 px-4 pb-3 pt-[max(env(safe-area-inset-top),0.75rem)] backdrop-blur sm:px-6"
      data-testid="session-header"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <a className="text-muted-foreground transition-colors hover:text-foreground" href="/">
              &larr; Dashboard
            </a>
            <span className="text-muted-foreground">/</span>
            <span className="font-medium">{session.project}</span>
            <StatusBadge status={session.status} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {session.model && (
              <Badge className="text-xs" variant="outline">
                {session.model}
              </Badge>
            )}
            {session.num_turns != null && (
              <span className="text-xs text-muted-foreground">
                {session.num_turns} turn{session.num_turns === 1 ? '' : 's'}
              </span>
            )}
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.min((session.num_turns ?? 0) * 5, 100)}%` }}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
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
            <Button className="min-h-11" onClick={onAbort} size="sm" variant="destructive">
              Abort
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<
    string,
    {
      label: string
      variant: 'default' | 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'
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

  const value = variants[status] ?? { variant: 'outline' as const, label: status }
  return <Badge variant={value.variant}>{value.label}</Badge>
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function ChatView({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<SessionState | null>(null)
  const transport = useMemo(() => new WsChatTransport(sessionId), [sessionId])
  const {
    addToolApprovalResponse,
    messages,
    sendMessage,
    setMessages,
    status: chatStatus,
  } = useChat({
    id: sessionId,
    transport,
  })

  const loadSession = useCallback(async () => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}`)
      if (!response.ok) {
        return
      }

      const payload = (await response.json()) as { session?: SessionState }
      if (payload.session) {
        setSession(payload.session)
      }
    } catch {
      // Ignore transient session refresh errors; polling or navigation can recover.
    }
  }, [sessionId])

  useEffect(() => {
    void loadSession()
    const interval = setInterval(() => {
      void loadSession()
    }, 1000)

    return () => clearInterval(interval)
  }, [loadSession])

  useEffect(() => {
    let cancelled = false

    transport
      .loadHistory()
      .then((stored) => {
        if (cancelled) return
        setMessages(storedToUIMessages(stored))
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [setMessages, transport])

  const pendingQuestionToolCallId =
    session?.pending_question?.tool_call_id ?? getLatestAskUserQuestionToolCallId(messages)

  const handleToolApproval = useCallback(
    async (toolCallId: string, approved: boolean) => {
      const response = await fetch(`/api/sessions/${sessionId}/tool-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved, toolCallId }),
      })
      if (!response.ok) {
        return
      }

      addToolApprovalResponse({ id: toolCallId, approved })
      await loadSession()
    },
    [addToolApprovalResponse, loadSession, sessionId],
  )

  const handleQuestionAnswer = useCallback(
    async (answers: Record<string, string>) => {
      if (!session?.pending_question || !pendingQuestionToolCallId) return
      const response = await fetch(`/api/sessions/${sessionId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers,
          toolCallId: pendingQuestionToolCallId,
        }),
      })
      if (!response.ok) {
        return
      }

      await loadSession()
    },
    [loadSession, pendingQuestionToolCallId, session?.pending_question, sessionId],
  )

  const handleAbort = useCallback(() => {
    if (
      (globalThis as unknown as { confirm: (message: string) => boolean }).confirm(
        'Are you sure you want to abort this session?',
      )
    ) {
      void fetch(`/api/sessions/${sessionId}/abort`, { method: 'POST' }).catch(() => {})
    }
  }, [sessionId])

  const isActive = session
    ? ['running', 'waiting_input', 'waiting_permission', 'idle'].includes(session.status)
    : false

  const isStreaming = chatStatus === 'streaming' || chatStatus === 'submitted'

  return (
    <div className="flex min-h-dvh flex-col">
      <SessionHeader onAbort={handleAbort} session={session} />

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            onToolApprove={(toolCallId) => {
              void handleToolApproval(toolCallId, true)
            }}
            onToolDeny={(toolCallId) => {
              void handleToolApproval(toolCallId, false)
            }}
          />
        ))}
      </div>

      {session?.pending_question && session.status === 'waiting_input' && (
        <div className="px-4 pb-3 sm:px-6">
          <QuestionPrompt
            onSubmit={handleQuestionAnswer}
            questions={session.pending_question.questions}
          />
        </div>
      )}

      <PromptInput
        disabled={!isActive || isStreaming}
        onSend={(text) => {
          void sendMessage({ text })
        }}
      />
    </div>
  )
}
