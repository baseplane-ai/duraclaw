/**
 * GH#152 P1.4 B12 — React hooks layered on `createArcReactionsCollection`.
 *
 * Reads: `useReactionsForTarget(arcId, targetKind, targetId)` returns a
 * pre-grouped chip list `{emoji, count, users}[]` plus a `userReacted`
 * Set of emojis the current user has on this target — drives the
 * "pressed" visual state on a chip.
 *
 * Writes: `useReactionActions(arcId)` exposes `toggleReaction`. The
 * toggle endpoint is one REST call per click — the server decides
 * `added` vs `removed` based on existing-row presence and broadcasts
 * the matching INSERT or DELETE op. The WS echo handles the actual
 * collection delta; no optimistic insert here (the server flip is the
 * source of truth, and the optimistic shape would have to know the
 * existing-row outcome up front).
 */

import type { ReactionRow } from '@duraclaw/shared-types'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { createArcReactionsCollection } from '~/db/arc-reactions-collection'
import { useSession } from '~/lib/auth-client'
import { apiUrl } from '~/lib/platform'

/** MVP emoji palette — 7 universally-recognised glyphs. */
export const EMOJI_SET = ['👍', '❤️', '😂', '🎉', '🚀', '👀', '🙏'] as const

export type ReactionTargetKind = 'comment' | 'chat'

export interface ReactionChip {
  emoji: string
  count: number
  users: string[]
}

export interface ReactionsForTarget {
  chips: ReactionChip[]
  userReacted: Set<string>
}

/**
 * Read all reactions for a single (targetKind, targetId), grouped by
 * emoji. Returned chips are sorted by first-press time (chronological
 * first appearance of the emoji on this target) so chip order is stable
 * across renders.
 */
export function useReactionsForTarget(
  arcId: string,
  targetKind: ReactionTargetKind,
  targetId: string,
): ReactionsForTarget {
  const collection = useMemo(() => createArcReactionsCollection(arcId), [arcId])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery((q) => q.from({ reactions: collection as any }), [collection])

  const { data: session } = useSession() as {
    data: { user?: { id?: string } } | null | undefined
  }
  const currentUserId = session?.user?.id ?? null

  return useMemo(() => {
    const rows = (data ?? []) as ReactionRow[]
    const matched = rows.filter((r) => r.targetKind === targetKind && r.targetId === targetId)

    // Group by emoji. Track first-press time per emoji for stable order.
    const byEmoji = new Map<string, { users: string[]; firstAt: number }>()
    for (const r of matched) {
      const bucket = byEmoji.get(r.emoji)
      if (bucket) {
        bucket.users.push(r.userId)
        if (r.createdAt < bucket.firstAt) bucket.firstAt = r.createdAt
      } else {
        byEmoji.set(r.emoji, { users: [r.userId], firstAt: r.createdAt })
      }
    }

    const chips: ReactionChip[] = Array.from(byEmoji.entries())
      .map(([emoji, { users, firstAt }]) => ({ emoji, count: users.length, users, firstAt }))
      .sort((a, b) => a.firstAt - b.firstAt)
      .map(({ emoji, count, users }) => ({ emoji, count, users }))

    const userReacted = new Set<string>()
    if (currentUserId) {
      for (const r of matched) {
        if (r.userId === currentUserId) userReacted.add(r.emoji)
      }
    }

    return { chips, userReacted }
  }, [data, targetKind, targetId, currentUserId])
}

export interface ToggleReactionArgs {
  targetKind: ReactionTargetKind
  targetId: string
  emoji: string
}

export interface ReactionActions {
  toggleReaction: (args: ToggleReactionArgs) => Promise<{ ok: boolean; error?: string }>
  /** Current authenticated user id (for "pressed" UI checks if needed at the call site). */
  currentUserId: string | null
}

export function useReactionActions(arcId: string): ReactionActions {
  const { data: session } = useSession() as {
    data: { user?: { id?: string } } | null | undefined
  }
  const currentUserId = session?.user?.id ?? null

  const toggleReaction = useCallback(
    async ({ targetKind, targetId, emoji }: ToggleReactionArgs) => {
      try {
        const resp = await fetch(
          apiUrl(`/api/arcs/${encodeURIComponent(arcId)}/reactions/toggle`),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetKind, targetId, emoji }),
          },
        )
        if (!resp.ok) {
          let errMsg = `toggleReaction ${resp.status}`
          try {
            const j = (await resp.json()) as { error?: string }
            if (j?.error) errMsg = j.error
          } catch {
            // fall through
          }
          toast.error(errMsg)
          return { ok: false, error: errMsg }
        }
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(msg)
        return { ok: false, error: msg }
      }
    },
    [arcId],
  )

  return { toggleReaction, currentUserId }
}
