/**
 * GH#152 P1.3 WU-D — React hooks layered on `createArcChatCollection`.
 *
 * Reads: `useArcChat(arcId)` returns the per-arc chat row list sorted by
 * `createdAt ASC` (oldest first; UI scrolls to the bottom for newest).
 * Tombstones (rows with `deletedAt !== null`) stay in the list so the UI
 * can render them as "deleted by X N ago" per spec B5 — it's the panel's
 * job to switch presentation by `deletedAt`.
 *
 * Writes: `useArcChatActions(arcId)` exposes `sendChat` / `editChat` /
 * `deleteChat`. `sendChat` uses an optimistic insert through the
 * collection so TanStack DB rolls back on REST failure; the WS echo
 * reconciles the canonical row in place via the factory's upsert-by-key.
 * `editChat` / `deleteChat` are non-optimistic — the WS echo delivers
 * the canonical row.
 */

import type { ChatMessageRow } from '@duraclaw/shared-types'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo } from 'react'
import { createArcChatCollection } from '~/db/arc-chat-collection'
import { useSession } from '~/lib/auth-client'
import { apiUrl } from '~/lib/platform'

/**
 * Read all chat rows for an arc, sorted chronologically (`createdAt ASC`).
 * Tombstoned rows are retained — the renderer shows a "deleted" placeholder.
 */
export function useArcChat(arcId: string): ChatMessageRow[] {
  const collection = useMemo(() => createArcChatCollection(arcId), [arcId])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery((q) => q.from({ chat: collection as any }), [collection])

  return useMemo(() => {
    const rows = (data ?? []) as ChatMessageRow[]
    // Defensive copy before sort — `data` is a live reference.
    return [...rows].sort((a, b) => a.createdAt - b.createdAt)
  }, [data])
}

export interface SendChatArgs {
  body: string
}

export interface EditChatArgs {
  chatId: string
  body: string
}

export interface DeleteChatArgs {
  chatId: string
}

export interface ArcChatActions {
  sendChat: (args: SendChatArgs) => Promise<{ ok: boolean; error?: string }>
  editChat: (args: EditChatArgs) => Promise<{ ok: boolean; error?: string }>
  deleteChat: (args: DeleteChatArgs) => Promise<{ ok: boolean; error?: string }>
  /** Current authenticated user id (for "is this my chat" UI checks). */
  currentUserId: string | null
}

export function useArcChatActions(arcId: string): ArcChatActions {
  const collection = useMemo(() => createArcChatCollection(arcId), [arcId])

  const { data: session } = useSession() as {
    data: { user?: { id?: string } } | null | undefined
  }
  const currentUserId = session?.user?.id ?? null

  const sendChat = useCallback(
    async ({ body }: SendChatArgs) => {
      if (!currentUserId) {
        return { ok: false, error: 'not authenticated' }
      }
      const clientChatId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const now = Date.now()
      const optimistic: ChatMessageRow = {
        id: clientChatId,
        arcId,
        authorUserId: currentUserId,
        body,
        mentions: null,
        createdAt: now,
        modifiedAt: now,
        editedAt: null,
        deletedAt: null,
        deletedBy: null,
      }
      try {
        // Factory's `onInsert` (arc-chat-collection) owns the POST + 409
        // idempotency; throwing rolls back the optimistic row.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tx = (collection as any).insert(optimistic)
        await tx.isPersisted.promise
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    [collection, arcId, currentUserId],
  )

  const editChat = useCallback(
    async ({ chatId, body }: EditChatArgs) => {
      try {
        const resp = await fetch(
          apiUrl(`/api/arcs/${encodeURIComponent(arcId)}/chat/${encodeURIComponent(chatId)}`),
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ body }),
          },
        )
        if (!resp.ok) {
          let errMsg = `editChat ${resp.status}`
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
    [arcId],
  )

  const deleteChat = useCallback(
    async ({ chatId }: DeleteChatArgs) => {
      try {
        const resp = await fetch(
          apiUrl(`/api/arcs/${encodeURIComponent(arcId)}/chat/${encodeURIComponent(chatId)}`),
          { method: 'DELETE' },
        )
        if (!resp.ok) {
          let errMsg = `deleteChat ${resp.status}`
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
    [arcId],
  )

  return { sendChat, editChat, deleteChat, currentUserId }
}
