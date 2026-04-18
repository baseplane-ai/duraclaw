/**
 * GateResolver — UI for resolving CodingAgent permission/question gates.
 */

import { useState } from 'react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import type { GateResponse } from '~/lib/types'
import { cn } from '~/lib/utils'

interface Question {
  question: string
  header: string
  options: Array<{
    label: string
    description: string
  }>
  multiSelect: boolean
}

interface GateResolverProps {
  gate: {
    id: string
    type: 'permission_request' | 'ask_user'
    detail: unknown
  }
  onResolve: (gateId: string, response: GateResponse) => Promise<unknown>
  onResolved?: (question: string, answer: string) => void
}

export function GateResolver({ gate, onResolve, onResolved }: GateResolverProps) {
  const [answer, setAnswer] = useState('')
  const [resolving, setResolving] = useState(false)
  const [selections, setSelections] = useState<Map<number, Set<string>>>(new Map())
  const [otherText, setOtherText] = useState('')

  const handleResolve = async (response: GateResponse) => {
    setResolving(true)
    try {
      await onResolve(gate.id, response)
    } finally {
      setResolving(false)
      setAnswer('')
    }
  }

  if (gate.type === 'permission_request') {
    const detail =
      typeof gate.detail === 'string' ? gate.detail : JSON.stringify(gate.detail, null, 2)

    return (
      <div className="min-w-0 space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
        <div className="text-sm font-medium text-warning">Permission Request</div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
          {detail}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="default"
            disabled={resolving}
            className="flex-1 sm:flex-none"
            onClick={() => handleResolve({ approved: true })}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={resolving}
            className="flex-1 sm:flex-none"
            onClick={() => handleResolve({ approved: false })}
          >
            Deny
          </Button>
        </div>
      </div>
    )
  }

  if (gate.type === 'ask_user') {
    const detailObj = gate.detail as { questions?: Question[]; question?: string }
    const questions = detailObj?.questions

    // Legacy fallback: no structured questions array
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      const question =
        typeof detailObj?.question === 'string'
          ? detailObj.question
          : JSON.stringify(gate.detail, null, 2)

      const handleAskUserResolve = async (userAnswer: string) => {
        await handleResolve({ answer: userAnswer })
        onResolved?.(question, userAnswer)
      }

      return (
        <div className="min-w-0 space-y-3 rounded-lg border border-info/30 bg-info/5 p-3">
          <div className="text-sm font-medium text-info">Agent Question</div>
          <p className="break-words text-sm">{question}</p>
          <Label className="sr-only" htmlFor="gate-answer">
            Answer
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="gate-answer"
              className="min-w-0 flex-1"
              placeholder="Type your answer..."
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && answer.trim()) {
                  handleAskUserResolve(answer.trim())
                }
              }}
            />
            <Button
              size="sm"
              className="w-full sm:w-auto"
              disabled={resolving || !answer.trim()}
              onClick={() => handleAskUserResolve(answer.trim())}
            >
              Submit
            </Button>
          </div>
        </div>
      )
    }

    // Structured questions UI
    const toggleSelection = (qIndex: number, label: string, multiSelect: boolean) => {
      setSelections((prev) => {
        const next = new Map(prev)
        const current = new Set(prev.get(qIndex) ?? [])
        if (multiSelect) {
          if (current.has(label)) {
            current.delete(label)
          } else {
            current.add(label)
          }
        } else {
          current.clear()
          current.add(label)
        }
        next.set(qIndex, current)
        return next
      })
    }

    const hasSelection = Array.from(selections.values()).some((s) => s.size > 0)
    const trimmedOther = otherText.trim()
    const canSubmit = Boolean(trimmedOther) || hasSelection

    const buildAnswer = (): string => {
      const parts: string[] = []
      for (let i = 0; i < questions.length; i++) {
        const selected = selections.get(i)
        if (selected && selected.size > 0) {
          parts.push(Array.from(selected).join(', '))
        }
      }
      const selectionStr = parts.join('; ')
      if (selectionStr && trimmedOther) {
        return `${selectionStr}; Additional context: ${trimmedOther}`
      }
      return selectionStr || trimmedOther
    }

    const handleStructuredSubmit = async () => {
      const answerStr = buildAnswer()
      await handleResolve({ answer: answerStr })
      const questionText = questions.map((q) => q.question).join('; ')
      onResolved?.(questionText, answerStr)
    }

    return (
      <div className="min-w-0 space-y-3 rounded-lg border border-info/30 bg-info/5 p-3">
        <div className="text-sm font-medium text-info">Agent Question</div>

        {questions.map((q, qIndex) => (
          <div key={q.header} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="max-w-full break-words">
                {q.header}
              </Badge>
            </div>
            <p className="break-words text-sm">{q.question}</p>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {q.options.map((opt) => {
                const selected = selections.get(qIndex)?.has(opt.label) ?? false
                return (
                  <Button
                    key={opt.label}
                    variant="outline"
                    size="sm"
                    disabled={resolving}
                    aria-pressed={selected}
                    className={cn(
                      'h-auto min-h-8 w-full justify-start whitespace-normal px-3 py-2 text-left sm:w-auto sm:max-w-xs',
                      selected && 'border-info ring-2 ring-info',
                    )}
                    onClick={() => toggleSelection(qIndex, opt.label, q.multiSelect)}
                  >
                    <span className="flex w-full min-w-0 flex-col items-start gap-0.5 text-left">
                      <span className="break-words font-bold">{opt.label}</span>
                      <span className="break-words text-xs text-muted-foreground">
                        {opt.description}
                      </span>
                    </span>
                  </Button>
                )
              })}
            </div>
          </div>
        ))}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label="Other answer"
            className="min-w-0 flex-1"
            placeholder="Other..."
            value={otherText}
            disabled={resolving}
            onChange={(e) => {
              setOtherText(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                handleStructuredSubmit()
              }
            }}
          />
          <Button
            size="sm"
            className="w-full sm:w-auto"
            disabled={resolving || !canSubmit}
            onClick={handleStructuredSubmit}
          >
            Submit
          </Button>
        </div>
      </div>
    )
  }

  return null
}
