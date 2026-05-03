/**
 * GH#152 P1.2 WU-D — React hooks layered on `createCommentsCollection`.
 *
 * Reads: `useCommentsForMessage` and `useCommentsCountByMessage` are thin
 * `useLiveQuery` wrappers around the WS-driven, OPFS-persisted comments
 * collection (factory at `~/db/comments-collection.ts`). Both filter
 * client-side rather than via TanStack DB query expressions because the
 * collection is already scoped to a single sessionId.
 *
 * Writes: `useCommentActions` exposes `addComment` / `editComment` /
 * `deleteComment`. `addComment` uses an optimistic insert through the
 * collection (so TanStack DB rolls back on REST failure) and the WS echo
 * reconciles in place via the factory's upsert-by-key. `editComment` /
 * `deleteComment` are non-optimistic — the WS echo brings the canonical row.
 *
 * Lock state: `isMessageStreaming` is backed by a `Set<string>` populated
 * from the SessionDO's `comment_lock` / `comment_unlock` top-level WS
 * frames (see `subscribeSessionLockFrame` in `use-coding-agent.ts`). When
 * the gate is closed for a given messageId, the composer disables the Post
 * button (B8 lock-during-stream).
 */

import type { CommentRow } from '@duraclaw/shared-types'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createCommentsCollection } from '~/db/comments-collection'
import { useSession } from '~/lib/auth-client'
import { apiUrl } from '~/lib/platform'
import { subscribeSessionLockFrame } from './use-coding-agent'

/**
 * Read all comments anchored at a given (sessionId, messageId).
 *
 * Returns:
 *  - `comments`: top-level comments (parentCommentId === null) sorted by
 *    `createdAt ASC`.
 *  - `replies`: a Map keyed by parent commentId → child comments sorted by
 *    `createdAt ASC`. Children of children (depth > 1) collapse into the
 *    nearest known parent's bucket — the UI only renders one level (B7).
 */
export function useCommentsForMessage(
  sessionId: string,
  messageId: string,
): { comments: CommentRow[]; replies: Map<string, CommentRow[]> } {
  const collection = useMemo(() => createCommentsCollection(sessionId), [sessionId])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery((q) => q.from({ comments: collection as any }), [collection])

  return useMemo(() => {
    const rows = (data ?? []) as CommentRow[]
    const filtered = rows.filter((r) => r.messageId === messageId)
    const top: CommentRow[] = []
    const repliesByParent = new Map<string, CommentRow[]>()
    const idSet = new Set(filtered.map((r) => r.id))
    for (const r of filtered) {
      if (r.parentCommentId === null || !idSet.has(r.parentCommentId)) {
        // Top-level OR an orphaned child whose parent isn't in this
        // message's comment set — render it at the top level so it isn't
        // lost. Defensive against cross-message parent FKs.
        if (r.parentCommentId === null) {
          top.push(r)
        } else {
          // Orphaned reply — surface alongside top-level so it's visible.
          top.push(r)
        }
      } else {
        let bucket = repliesByParent.get(r.parentCommentId)
        if (!bucket) {
          bucket = []
          repliesByParent.set(r.parentCommentId, bucket)
        }
        bucket.push(r)
      }
    }
    const byCreated = (a: CommentRow, b: CommentRow) => a.createdAt - b.createdAt
    top.sort(byCreated)
    for (const bucket of repliesByParent.values()) bucket.sort(byCreated)
    return { comments: top, replies: repliesByParent }
  }, [data, messageId])
}

/**
 * Per-message non-deleted comment counts, for the transcript badge. Memoised
 * by collection identity so re-renders that don't grow the row set reuse
 * the prior Map reference.
 */
export function useCommentsCountByMessage(sessionId: string): Map<string, number> {
  const collection = useMemo(() => createCommentsCollection(sessionId), [sessionId])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery((q) => q.from({ comments: collection as any }), [collection])

  return useMemo(() => {
    const counts = new Map<string, number>()
    const rows = (data ?? []) as CommentRow[]
    for (const r of rows) {
      if (r.deletedAt !== null) continue
      counts.set(r.messageId, (counts.get(r.messageId) ?? 0) + 1)
    }
    return counts
  }, [data])
}

export interface AddCommentArgs {
  messageId: string
  body: string
  parentCommentId?: string | null
}

export interface EditCommentArgs {
  commentId: string
  body: string
}

export interface DeleteCommentArgs {
  commentId: string
}

export interface CommentActions {
  addComment: (args: AddCommentArgs) => Promise<{ ok: boolean; error?: string }>
  editComment: (args: EditCommentArgs) => Promise<{ ok: boolean; error?: string }>
  deleteComment: (args: DeleteCommentArgs) => Promise<{ ok: boolean; error?: string }>
  isMessageStreaming: (messageId: string) => boolean
  /** Current authenticated user id (for "is this my comment" UI checks). */
  currentUserId: string | null
}

/**
 * Imperative actions for adding / editing / deleting comments on a session,
 * plus a reactive `isMessageStreaming` predicate driven by the DO's
 * `comment_lock` / `comment_unlock` broadcasts.
 */
export function useCommentActions(sessionId: string): CommentActions {
  const collection = useMemo(() => createCommentsCollection(sessionId), [sessionId])

  const { data: session } = useSession() as {
    data: { user?: { id?: string } } | null | undefined
  }
  const currentUserId = session?.user?.id ?? null

  // Track the per-message lock state. Reactive via React state so consumers
  // re-render when the DO toggles a lock. The Set is replaced (not mutated)
  // on each transition so identity changes flow through useState's bailout.
  const [lockedMessageIds, setLockedMessageIds] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    const unsub = subscribeSessionLockFrame(sessionId, (frame) => {
      setLockedMessageIds((prev) => {
        const next = new Set(prev)
        if (frame.type === 'comment_lock') {
          if (next.has(frame.messageId)) return prev
          next.add(frame.messageId)
        } else {
          if (!next.has(frame.messageId)) return prev
          next.delete(frame.messageId)
        }
        return next
      })
    })
    return () => {
      unsub()
      // Drop the local lock map on session change so a switched-in tab
      // doesn't carry stale locks from a prior session.
      setLockedMessageIds(new Set())
    }
  }, [sessionId])

  // Capture the latest lock set in a ref so the `isMessageStreaming`
  // callback can stay reference-stable across renders even though the
  // underlying Set churns.
  const lockedRef = useRef(lockedMessageIds)
  lockedRef.current = lockedMessageIds

  const isMessageStreaming = useCallback(
    (messageId: string) => lockedRef.current.has(messageId),
    [],
  )

  const addComment = useCallback(
    async ({ messageId, body, parentCommentId = null }: AddCommentArgs) => {
      if (!currentUserId) {
        return { ok: false, error: 'not authenticated' }
      }
      const clientCommentId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const now = Date.now()
      const optimistic: CommentRow = {
        id: clientCommentId,
        // arcId is server-assigned; the WS echo overwrites this placeholder.
        arcId: '',
        sessionId,
        messageId,
        parentCommentId,
        authorUserId: currentUserId,
        body,
        // GH#152 P1.5: server-resolved on the WS echo (parseMentions
        // runs against arc_members on the SessionDO). Optimistic insert
        // shows no mention chips until the round-trip lands.
        mentions: null,
        createdAt: now,
        modifiedAt: now,
        editedAt: null,
        deletedAt: null,
        deletedBy: null,
      }
      try {
        // The factory's `onInsert` (commentsCollectionOptions) owns the
        // POST + 409 idempotency. Throwing from onInsert auto-rolls back
        // the optimistic row.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tx = (collection as any).insert(optimistic)
        await tx.isPersisted.promise
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    [collection, sessionId, currentUserId],
  )

  const editComment = useCallback(
    async ({ commentId, body }: EditCommentArgs) => {
      try {
        const resp = await fetch(
          apiUrl(
            `/api/sessions/${encodeURIComponent(sessionId)}/comments/${encodeURIComponent(commentId)}`,
          ),
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ body }),
          },
        )
        if (!resp.ok) {
          let errMsg = `editComment ${resp.status}`
          try {
            const j = (await resp.json()) as { error?: string }
            if (j?.error) errMsg = j.error
          } catch {
            // fall through
          }
          throw new Error(errMsg)
        }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    [sessionId],
  )

  const deleteComment = useCallback(
    async ({ commentId }: DeleteCommentArgs) => {
      try {
        const resp = await fetch(
          apiUrl(
            `/api/sessions/${encodeURIComponent(sessionId)}/comments/${encodeURIComponent(commentId)}`,
          ),
          { method: 'DELETE' },
        )
        if (!resp.ok) {
          let errMsg = `deleteComment ${resp.status}`
          try {
            const j = (await resp.json()) as { error?: string }
            if (j?.error) errMsg = j.error
          } catch {
            // fall through
          }
          throw new Error(errMsg)
        }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    [sessionId],
  )

  return { addComment, editComment, deleteComment, isMessageStreaming, currentUserId }
}
