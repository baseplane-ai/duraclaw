/**
 * GateResolver — UI for resolving CodingAgent permission/question gates.
 */

import { useState } from 'react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import type { GateResponse } from '~/lib/types'

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
      <div className="space-y-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3">
        <div className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
          Permission Request
        </div>
        <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
          {detail}
        </pre>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="default"
            disabled={resolving}
            onClick={() => handleResolve({ approved: true })}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={resolving}
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
        <div className="space-y-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
          <div className="text-sm font-medium text-blue-600 dark:text-blue-400">Agent Question</div>
          <p className="text-sm">{question}</p>
          <div className="flex gap-2">
            <Label className="sr-only" htmlFor="gate-answer">
              Answer
            </Label>
            <Input
              id="gate-answer"
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
    const canSubmit = otherText.trim() || hasSelection

    const buildAnswer = (): string => {
      if (otherText.trim()) return otherText.trim()
      const parts: string[] = []
      for (let i = 0; i < questions.length; i++) {
        const selected = selections.get(i)
        if (selected && selected.size > 0) {
          parts.push(Array.from(selected).join(', '))
        }
      }
      return parts.join('; ')
    }

    const handleStructuredSubmit = async () => {
      const answerStr = buildAnswer()
      await handleResolve({ answer: answerStr })
      const questionText = questions.map((q) => q.question).join('; ')
      onResolved?.(questionText, answerStr)
    }

    return (
      <div className="space-y-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
        <div className="text-sm font-medium text-blue-600 dark:text-blue-400">Agent Question</div>

        {questions.map((q, qIndex) => (
          <div key={q.header} className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{q.header}</Badge>
            </div>
            <p className="text-sm">{q.question}</p>
            <div className="flex flex-wrap gap-2">
              {q.options.map((opt) => {
                const selected = selections.get(qIndex)?.has(opt.label) ?? false
                return (
                  <Button
                    key={opt.label}
                    variant="outline"
                    size="sm"
                    disabled={resolving}
                    aria-pressed={selected}
                    className={selected ? 'ring-2 ring-blue-500 border-blue-500' : ''}
                    onClick={() => toggleSelection(qIndex, opt.label, q.multiSelect)}
                  >
                    <span className="flex flex-col items-start text-left">
                      <span className="font-bold">{opt.label}</span>
                      <span className="text-xs text-muted-foreground">{opt.description}</span>
                    </span>
                  </Button>
                )
              })}
            </div>
          </div>
        ))}

        <div className="flex gap-2">
          <Input
            aria-label="Other answer"
            placeholder="Other..."
            value={otherText}
            disabled={resolving}
            onChange={(e) => {
              setOtherText(e.target.value)
              if (e.target.value.trim()) {
                setSelections(new Map())
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                handleStructuredSubmit()
              }
            }}
          />
          <Button size="sm" disabled={resolving || !canSubmit} onClick={handleStructuredSubmit}>
            Submit
          </Button>
        </div>
      </div>
    )
  }

  return null
}
