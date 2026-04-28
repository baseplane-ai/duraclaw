/**
 * GateResolver — UI for resolving CodingAgent permission/question gates.
 */

import { Loader2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import type { GateResponse, StructuredAnswer } from '~/lib/types'
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
}

// Delay before showing the in-flight spinner after Submit. Short enough
// that a slow resolve feels loading rather than hung; long enough that the
// optimistic write in use-coding-agent `resolveGate` gets a chance to flip
// the underlying part to output-available and unmount this component
// first. React's batched render + TanStack DB's live-query propagation
// usually lands well inside 120ms, so the happy path never paints the
// disabled styling — no flash. When the optimistic write didn't apply
// (no matching pending part, or the part was mutated mid-RPC) we still
// give the user feedback that something is in flight.
const SPINNER_GRACE_MS = 120

export function GateResolver({ gate, onResolve }: GateResolverProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [answer, setAnswer] = useState('')
  const [resolving, setResolving] = useState(false)
  const [selections, setSelections] = useState<Map<number, Set<string>>>(new Map())
  const [notesByQuestion, setNotesByQuestion] = useState<Map<number, string>>(new Map())

  // Auto-scroll the gate into view when it mounts. The old pinned-gate div
  // was removed (9c1f759) and gates now render inline in the message list.
  // Without this, a gate in a message above the viewport is invisible.
  // `block: 'start'` pins the gate's top edge to the viewport top so the
  // question(s) are what the user sees first — centering pushed short
  // gates into the middle of the screen with blank space above.
  useEffect(() => {
    // Small delay so the layout settles before measuring position.
    const t = setTimeout(() => {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 80)
    return () => clearTimeout(t)
  }, []) // mount-only

  const handleResolve = async (response: GateResponse) => {
    setAnswer('')
    // Delayed spinner: only flip `resolving` → true if the optimistic
    // unmount hasn't landed within SPINNER_GRACE_MS. If it did land, this
    // component is already gone and the setTimeout no-ops. If it didn't,
    // we surface disabled buttons + a spinner on Submit so the user knows
    // we're waiting on the server.
    const spinnerTimer = setTimeout(() => setResolving(true), SPINNER_GRACE_MS)
    try {
      const raw = await onResolve(gate.id, response)
      const result = raw as { ok?: boolean; error?: string } | null | undefined
      if (!result || result.ok !== true) {
        toast.error(result?.error || 'Failed to submit response — try again')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit response')
    } finally {
      clearTimeout(spinnerTimer)
      // If we're still mounted (optimistic didn't fire), reset the
      // spinner so a retry click starts clean. If we already unmounted
      // (optimistic worked), this setState no-ops.
      setResolving(false)
    }
  }

  if (gate.type === 'permission_request') {
    const detail =
      typeof gate.detail === 'string' ? gate.detail : JSON.stringify(gate.detail, null, 2)

    return (
      <div
        ref={containerRef}
        className="flex min-w-0 flex-col gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3"
      >
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
            {resolving ? <Loader2Icon className="size-3 animate-spin" /> : null}
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
      }

      return (
        <div
          ref={containerRef}
          className="flex min-w-0 flex-col gap-3 rounded-lg border border-info/30 bg-info/5 p-3"
        >
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
              {resolving ? <Loader2Icon className="size-3 animate-spin" /> : null}
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
    const hasAnyNote = Array.from(notesByQuestion.values()).some((n) => n.trim().length > 0)
    const canSubmit = hasSelection || hasAnyNote

    const buildStructuredAnswers = (): StructuredAnswer[] => {
      const result: StructuredAnswer[] = []
      for (let i = 0; i < questions.length; i++) {
        const selected = selections.get(i)
        const label = selected && selected.size > 0 ? Array.from(selected).join(', ') : ''
        const note = (notesByQuestion.get(i) ?? '').trim()
        if (!label && !note) continue // skip unanswered entries entirely — server's flatten helper also skips them
        result.push(note ? { label, note } : { label })
      }
      return result
    }

    const setNoteFor = (qIndex: number, value: string) => {
      setNotesByQuestion((prev) => {
        const next = new Map(prev)
        next.set(qIndex, value)
        return next
      })
    }

    const handleStructuredSubmit = async () => {
      const answers = buildStructuredAnswers()
      await handleResolve({ answers })
    }

    return (
      <div
        ref={containerRef}
        className="flex min-w-0 flex-col gap-3 rounded-lg border border-info/30 bg-info/5 p-3"
      >
        <div className="text-sm font-medium text-info">Agent Question</div>

        {questions.map((q, qIndex) => (
          <div key={q.header} className="flex flex-col gap-2">
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
            <Input
              aria-label={`Additional notes for ${q.header}`}
              className="min-w-0"
              placeholder="Add notes (optional) — adds to your choice, or use instead of one"
              value={notesByQuestion.get(qIndex) ?? ''}
              disabled={resolving}
              onChange={(e) => setNoteFor(qIndex, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  handleStructuredSubmit()
                }
              }}
            />
          </div>
        ))}

        <div className="flex justify-end">
          <Button
            size="sm"
            className="w-full sm:w-auto"
            disabled={resolving || !canSubmit}
            onClick={handleStructuredSubmit}
          >
            {resolving ? <Loader2Icon className="size-3 animate-spin" /> : null}
            Submit
          </Button>
        </div>
      </div>
    )
  }

  return null
}
