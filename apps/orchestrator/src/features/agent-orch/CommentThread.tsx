/**
 * GH#152 P1.2 WU-D — per-message comment drawer.
 *
 * Right-anchored Sheet that opens from the transcript-row badge. Renders
 * top-level comments + their direct children (B7 — one-level threading,
 * deeper depth flattens into the parent's bucket). Composer at the bottom
 * is gated by `comment_lock` (B8): while the assistant message is mid-
 * stream the textarea/Post button are disabled with a helper note.
 */

import type { CommentRow } from '@duraclaw/shared-types'
import { type FormEvent, type KeyboardEvent, useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { ReactionsBar } from '~/features/arc-orch/ReactionsBar'
import { cn } from '~/lib/utils'
import { useCommentActions, useCommentsForMessage } from './use-comments-collection'

interface CommentThreadProps {
  sessionId: string
  messageId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function relativeTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs
  if (diffMs < 60_000) return 'just now'
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  return `${days}d`
}

interface CommentRowViewProps {
  comment: CommentRow
  currentUserId: string | null
  onEdit: (commentId: string, body: string) => Promise<{ ok: boolean; error?: string }>
  onDelete: (commentId: string) => Promise<{ ok: boolean; error?: string }>
  onReply?: (commentId: string) => void
  isReply?: boolean
}

function CommentRowView({
  comment,
  currentUserId,
  onEdit,
  onDelete,
  onReply,
  isReply = false,
}: CommentRowViewProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const [saving, setSaving] = useState(false)

  const isMine = comment.authorUserId === currentUserId
  const isDeleted = comment.deletedAt !== null
  const isEdited = comment.editedAt !== null

  const handleSaveEdit = useCallback(async () => {
    if (saving) return
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    setSaving(true)
    const res = await onEdit(comment.id, trimmed)
    setSaving(false)
    if (!res.ok) {
      toast.error(res.error ?? 'Failed to edit comment')
      return
    }
    setEditing(false)
  }, [comment.id, draft, onEdit, saving])

  const handleCancelEdit = useCallback(() => {
    setEditing(false)
    setDraft(comment.body)
  }, [comment.body])

  const handleDelete = useCallback(async () => {
    const res = await onDelete(comment.id)
    if (!res.ok) toast.error(res.error ?? 'Failed to delete comment')
  }, [comment.id, onDelete])

  return (
    <div
      className={cn(
        'flex flex-col gap-1 border-b border-border py-3',
        isReply && 'ml-6 border-b-0 border-l border-border pl-3 pt-2',
      )}
      data-comment-id={comment.id}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate font-medium text-foreground">{comment.authorUserId}</span>
        <span className="shrink-0">
          {relativeTime(comment.createdAt)}
          {isEdited && !isDeleted && <span className="ml-1">(edited)</span>}
        </span>
      </div>
      {isDeleted ? (
        <div className="text-sm italic text-muted-foreground">
          deleted{comment.deletedBy ? ` by ${comment.deletedBy}` : ''}{' '}
          {relativeTime(comment.deletedAt ?? comment.modifiedAt)}
        </div>
      ) : editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[60px] w-full resize-y rounded border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={saving || draft.trim().length === 0}
              className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={handleCancelEdit}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words text-sm">{comment.body}</div>
      )}
      {!isDeleted && !editing && (
        <ReactionsBar arcId={comment.arcId} targetKind="comment" targetId={comment.id} />
      )}
      {!isDeleted && !editing && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {onReply && !isReply && (
            <button
              type="button"
              onClick={() => onReply(comment.id)}
              className="hover:text-foreground"
            >
              Reply
            </button>
          )}
          {isMine && (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="hover:text-foreground"
              >
                Edit
              </button>
              <button type="button" onClick={handleDelete} className="hover:text-destructive">
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

interface ComposerProps {
  disabled: boolean
  disabledReason?: string
  placeholder?: string
  onSubmit: (body: string) => Promise<{ ok: boolean; error?: string }>
  onCancel?: () => void
  autoFocus?: boolean
}

function Composer({
  disabled,
  disabledReason,
  placeholder = 'Add a comment…',
  onSubmit,
  onCancel,
  autoFocus,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = useCallback(async () => {
    const trimmed = text.trim()
    if (trimmed.length === 0 || busy || disabled) return
    setBusy(true)
    const res = await onSubmit(trimmed)
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error ?? 'Failed to post comment')
      return
    }
    setText('')
  }, [text, busy, disabled, onSubmit])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void submit()
      }
    },
    [submit],
  )

  const handleFormSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      void submit()
    },
    [submit],
  )

  return (
    <form onSubmit={handleFormSubmit} className="flex flex-col gap-2 border-t border-border p-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        // biome-ignore lint/a11y/noAutofocus: opt-in via autoFocus prop for inline reply composers
        autoFocus={autoFocus}
        className="min-h-[60px] w-full resize-y rounded border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
      />
      {disabled && disabledReason && (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={disabled || busy || text.trim().length === 0}
          className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Post
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

export function CommentThread({ sessionId, messageId, open, onOpenChange }: CommentThreadProps) {
  const { comments, replies } = useCommentsForMessage(sessionId, messageId)
  const { addComment, editComment, deleteComment, isMessageStreaming, currentUserId } =
    useCommentActions(sessionId)

  const [replyTo, setReplyTo] = useState<string | null>(null)

  const streaming = isMessageStreaming(messageId)
  const totalCount = useMemo(() => {
    let n = comments.length
    for (const bucket of replies.values()) n += bucket.length
    return n
  }, [comments, replies])

  const handleEdit = useCallback(
    (commentId: string, body: string) => editComment({ commentId, body }),
    [editComment],
  )
  const handleDelete = useCallback(
    (commentId: string) => deleteComment({ commentId }),
    [deleteComment],
  )

  const submitTopLevel = useCallback(
    async (body: string) => addComment({ messageId, body, parentCommentId: null }),
    [addComment, messageId],
  )
  const submitReply = useCallback(
    async (body: string) => {
      if (!replyTo) return { ok: false, error: 'no parent selected' }
      const res = await addComment({ messageId, body, parentCommentId: replyTo })
      if (res.ok) setReplyTo(null)
      return res
    },
    [addComment, messageId, replyTo],
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Comments ({totalCount})</SheetTitle>
          <SheetDescription className="sr-only">
            Comments anchored to this transcript message
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-3">
          {comments.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No comments yet</p>
          ) : (
            comments.map((c) => {
              const childBucket = replies.get(c.id) ?? []
              return (
                <div key={c.id} className="flex flex-col">
                  <CommentRowView
                    comment={c}
                    currentUserId={currentUserId}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onReply={(id) => setReplyTo(id)}
                  />
                  {childBucket.map((child) => (
                    <CommentRowView
                      key={child.id}
                      comment={child}
                      currentUserId={currentUserId}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                      isReply
                    />
                  ))}
                  {replyTo === c.id && (
                    <div className="ml-6 border-l border-border pl-3">
                      <Composer
                        disabled={streaming}
                        disabledReason={streaming ? 'Message is streaming…' : undefined}
                        placeholder="Reply…"
                        onSubmit={submitReply}
                        onCancel={() => setReplyTo(null)}
                        autoFocus
                      />
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        <Composer
          disabled={streaming}
          disabledReason={streaming ? 'Message is streaming…' : undefined}
          onSubmit={submitTopLevel}
        />
      </SheetContent>
    </Sheet>
  )
}
