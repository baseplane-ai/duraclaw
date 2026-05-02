/**
 * GH#152 P1.3 WU-D — per-arc Team chat panel (B11).
 *
 * Persistent right-rail surface (desktop) / "Team" tab (mobile). Renders
 * the `arcChat:<arcId>` collection in chronological order with a
 * composer at the bottom. Visually distinct background tone +
 * "Agent doesn't see this" caption per spec B11 — the chat is *not*
 * part of the agent transcript.
 *
 * Mounting is deferred to P1.9 (mobile polish + layout decision); for
 * now this component is callable in isolation (tests mount it standalone
 * with the hooks mocked).
 */

import type { ChatMessageRow } from '@duraclaw/shared-types'
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback } from '~/components/ui/avatar'
import { cn } from '~/lib/utils'
import { useArcChat, useArcChatActions } from './use-arc-chat'

interface TeamChatPanelProps {
  arcId: string
  className?: string
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

function initialOf(userId: string): string {
  const trimmed = userId.trim()
  if (trimmed.length === 0) return '?'
  return trimmed[0]?.toUpperCase() ?? '?'
}

interface ChatRowViewProps {
  message: ChatMessageRow
  currentUserId: string | null
  onEdit: (chatId: string, body: string) => Promise<{ ok: boolean; error?: string }>
  onDelete: (chatId: string) => Promise<{ ok: boolean; error?: string }>
}

function ChatRowView({ message, currentUserId, onEdit, onDelete }: ChatRowViewProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.body)
  const [saving, setSaving] = useState(false)

  const isMine = message.authorUserId === currentUserId
  const isDeleted = message.deletedAt !== null
  const isEdited = message.editedAt !== null

  const handleSaveEdit = useCallback(async () => {
    if (saving) return
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    setSaving(true)
    const res = await onEdit(message.id, trimmed)
    setSaving(false)
    if (!res.ok) {
      toast.error(res.error ?? 'Failed to edit message')
      return
    }
    setEditing(false)
  }, [message.id, draft, onEdit, saving])

  const handleCancelEdit = useCallback(() => {
    setEditing(false)
    setDraft(message.body)
  }, [message.body])

  const handleDelete = useCallback(async () => {
    const res = await onDelete(message.id)
    if (!res.ok) toast.error(res.error ?? 'Failed to delete message')
  }, [message.id, onDelete])

  return (
    <div className="flex gap-2 py-2" data-chat-id={message.id}>
      <Avatar className="size-7">
        <AvatarFallback className="text-xs font-medium">
          {initialOf(message.authorUserId)}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate font-medium text-foreground">{message.authorUserId}</span>
          <span className="shrink-0">
            {relativeTime(message.createdAt)}
            {isEdited && !isDeleted && <span className="ml-1">(edited)</span>}
          </span>
        </div>
        {isDeleted ? (
          <div className="text-sm italic text-muted-foreground">
            deleted{message.deletedBy ? ` by ${message.deletedBy}` : ''}{' '}
            {relativeTime(message.deletedAt ?? message.modifiedAt)}
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
          <div className="whitespace-pre-wrap break-words text-sm">{message.body}</div>
        )}
        {!isDeleted && !editing && isMine && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
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
          </div>
        )}
      </div>
    </div>
  )
}

interface ComposerProps {
  disabled: boolean
  placeholder: string
  onSubmit: (body: string) => Promise<{ ok: boolean; error?: string }>
}

function Composer({ disabled, placeholder, onSubmit }: ComposerProps) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = useCallback(async () => {
    const trimmed = text.trim()
    if (trimmed.length === 0 || busy || disabled) return
    setBusy(true)
    const res = await onSubmit(trimmed)
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error ?? 'Failed to send message')
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
        className="min-h-[60px] w-full resize-y rounded border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          disabled={disabled || busy || text.trim().length === 0}
          className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </form>
  )
}

export function TeamChatPanel({ arcId, className }: TeamChatPanelProps) {
  const messages = useArcChat(arcId)
  const { sendChat, editChat, deleteChat, currentUserId } = useArcChatActions(arcId)

  const handleEdit = useCallback(
    (chatId: string, body: string) => editChat({ chatId, body }),
    [editChat],
  )
  const handleDelete = useCallback((chatId: string) => deleteChat({ chatId }), [deleteChat])
  const handleSubmit = useCallback((body: string) => sendChat({ body }), [sendChat])

  // Auto-scroll to bottom on new message arrivals. Tracking the row count
  // (rather than identity) keeps the scroll behaviour stable across
  // optimistic-insert + WS-echo reconciliation (echo replaces the row in
  // place, so length doesn't change a second time).
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const lastCountRef = useRef(0)
  useEffect(() => {
    if (messages.length === lastCountRef.current) return
    lastCountRef.current = messages.length
    // `scrollIntoView({block:'end'})` would also scroll the page on
    // mobile when the panel isn't the active viewport. Manually setting
    // scrollTop avoids that — the panel scroller is self-contained.
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  return (
    <div
      className={cn('flex h-full flex-col bg-muted/30', 'border-l border-border', className)}
      data-team-chat-arc={arcId}
    >
      <div className="flex flex-col gap-0.5 border-b border-border bg-muted/50 px-3 py-2">
        <div className="text-sm font-semibold text-foreground">Team chat</div>
        <div className="text-xs text-muted-foreground">Agent doesn’t see this</div>
      </div>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-3">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No messages yet</p>
        ) : (
          messages.map((m) => (
            <ChatRowView
              key={m.id}
              message={m}
              currentUserId={currentUserId}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <Composer
        disabled={currentUserId === null}
        placeholder={
          currentUserId === null ? 'Sign in to chat with your team…' : 'Message your team…'
        }
        onSubmit={handleSubmit}
      />
    </div>
  )
}
