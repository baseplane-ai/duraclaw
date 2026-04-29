/**
 * BranchFromHereDialog — modal that opens from the per-message "Branch from
 * here" affordance in the chat view (GH#116 B16). On submit it POSTs to
 * `/api/arcs/:arcId/branch` (which dispatches to `branchArcImpl` on the
 * parent session's DO server-side) and, on a 201 response, navigates the
 * caller to `/?session=<newSessionId>`.
 *
 * Going through the HTTP endpoint (rather than calling the DO RPC directly
 * via `connection.call('branchArc', …)` exposed on `useCodingAgent`) keeps
 * the contract uniform with non-WS callers (e.g. the kanban Advance modal
 * that already POSTs `/api/arcs/:id/sessions`) and gets the server-side
 * arc / session ownership checks for free.
 */

import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { apiUrl } from '~/lib/platform'

export interface BranchFromHereDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Parent arc id (required to enable the affordance — caller guards). */
  arcId: string
  /** Source session id from which the new arc inherits its transcript. */
  fromSessionId: string
  /**
   * `fromMessageSeq` per `branchArcImpl` semantics: number of leading
   * history messages to include (`history.slice(0, fromMessageSeq)`).
   * The caller passes `turnIndex + 1` so the message the user clicked is
   * the last one carried into the new arc's `<prior_conversation>` wrap.
   */
  fromMessageSeq: number
  /** Current session's mode. Forwarded so the new arc's first session
   *  inherits it. Server treats null/undefined as "default mode" (kata's
   *  resolver decides). */
  mode?: string | null
  /** Parent arc title — drives the placeholder for the optional
   *  new-arc-title input. */
  parentArcTitle?: string | null
}

export function BranchFromHereDialog({
  open,
  onOpenChange,
  arcId,
  fromSessionId,
  fromMessageSeq,
  mode,
  parentArcTitle,
}: BranchFromHereDialogProps) {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Reset form on open. (`onOpenChange(false)` handlers wipe state too,
  // but the user might re-open on a different message and re-opening
  // with the previous prompt prefilled is confusing.)
  useEffect(() => {
    if (open) {
      setPrompt('')
      setTitle('')
      setSubmitting(false)
    }
  }, [open])

  // Spec: focus textarea on open. RAF defer because radix-dialog's mount
  // animation steals focus to the close button on the same tick.
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [open])

  const handleClose = useCallback(() => {
    if (submitting) return
    onOpenChange(false)
  }, [onOpenChange, submitting])

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault()
      const trimmedPrompt = prompt.trim()
      if (!trimmedPrompt || submitting) return
      setSubmitting(true)
      try {
        const resp = await fetch(apiUrl(`/api/arcs/${arcId}/branch`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            fromSessionId,
            fromMessageSeq,
            prompt: trimmedPrompt,
            mode: mode ?? null,
            ...(title.trim() ? { title: title.trim() } : {}),
          }),
        })
        if (resp.status === 201) {
          const body = (await resp.json().catch(() => null)) as {
            newSessionId?: string
            newArcId?: string
          } | null
          if (!body?.newSessionId) {
            toast.error('Branch failed: server did not return a session id.')
            setSubmitting(false)
            return
          }
          onOpenChange(false)
          navigate({ to: '/', search: { session: body.newSessionId } })
          return
        }
        // Error path — surface a toast and close the modal for 4xx
        // (invalid input or not found are both terminal from the user's
        // perspective; they need to start over). Network / 5xx leaves
        // the modal open so the user can retry without retyping.
        const text = await resp.text().catch(() => '')
        if (resp.status === 400) {
          toast.error(`Branch failed: invalid request — ${text || 'check inputs'}`)
          onOpenChange(false)
        } else if (resp.status === 404) {
          toast.error('Branch failed: arc or session not found.')
          onOpenChange(false)
        } else {
          toast.error(`Branch failed (${resp.status}). Try again.`)
          setSubmitting(false)
        }
      } catch (err) {
        toast.error(`Branch failed: ${err instanceof Error ? err.message : 'network error'}`)
        setSubmitting(false)
      }
    },
    [prompt, title, submitting, arcId, fromSessionId, fromMessageSeq, mode, navigate, onOpenChange],
  )

  const titlePlaceholder = parentArcTitle ? `${parentArcTitle} — side arc` : 'New side arc'

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Branch from here</DialogTitle>
          <DialogDescription>
            Creates a new arc seeded with the conversation up to this message. The new arc inherits
            the parent arc's external reference (e.g. GH issue) and links back via parentArcId.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label htmlFor="branch-from-here-prompt-input" className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">New prompt</span>
            <Textarea
              id="branch-from-here-prompt-input"
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should this side arc explore?"
              rows={4}
              disabled={submitting}
              data-testid="branch-from-here-prompt"
              required
              onKeyDown={(e) => {
                // Cmd/Ctrl-Enter submits, matching MessageInput's affordance.
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  void handleSubmit()
                }
              }}
            />
          </label>
          <label htmlFor="branch-from-here-title-input" className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Arc title (optional)</span>
            <Input
              id="branch-from-here-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={titlePlaceholder}
              disabled={submitting}
              data-testid="branch-from-here-title"
            />
          </label>
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting || prompt.trim().length === 0}
            data-testid="branch-from-here-submit"
          >
            {submitting ? 'Branching…' : 'Branch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
