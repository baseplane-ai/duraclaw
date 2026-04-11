/**
 * GateResolver — UI for resolving CodingAgent permission/question gates.
 */

import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import type { GateResponse } from '~/lib/types'

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
    const question =
      typeof (gate.detail as { question?: string })?.question === 'string'
        ? (gate.detail as { question: string }).question
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

  return null
}
