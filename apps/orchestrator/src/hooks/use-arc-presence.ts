/**
 * GH#152 P1.6 (B16) — composed presence across the per-arc and
 * per-session collab DOs.
 *
 * Glues `useArcCollab` + `useSessionCollab` together via
 * `composeAwareness`, returning a single per-user view (avatar / typing /
 * viewing) for the presence bar to render. Local user is filtered out so
 * users don't see themselves in their own bar.
 *
 * Re-renders whenever either provider's awareness emits 'change'. We
 * read both states on each event to avoid a stale-merge race
 * (merging only on the changed side would drop the other side's edits).
 */

import { useEffect, useState } from 'react'
import { useSession } from '~/lib/auth-client'
import { type ComposedPresence, composeAwareness } from '~/lib/composed-awareness'
import { useArcCollab } from './use-arc-collab'
import { useSessionCollab } from './use-session-collab'

export function useArcPresence(arcId: string, sessionId: string | null): ComposedPresence[] {
  const arc = useArcCollab({ arcId })
  // useSessionCollab requires a sessionId; pass empty string to keep
  // hook order stable when sessionId is null and ignore the result.
  const session = useSessionCollab({ sessionId: sessionId ?? '' })

  const arcAwareness = arc.awareness
  const sessionAwareness = sessionId ? session.awareness : null

  const { data: authData } = useSession() as {
    data: { user?: { id?: string } } | null | undefined
  }
  const localUserId = authData?.user?.id ?? null

  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!arcAwareness && !sessionAwareness) return
    const bump = () => setVersion((n) => (n + 1) % 1_000_000)
    arcAwareness?.on('change', bump)
    sessionAwareness?.on('change', bump)
    // Run once so the first snapshot reflects the current state — peers
    // already present at mount don't emit a 'change' on subscribe.
    bump()
    return () => {
      arcAwareness?.off('change', bump)
      sessionAwareness?.off('change', bump)
    }
  }, [arcAwareness, sessionAwareness])

  // `version` is consumed by useEffect's deps via setState — recompute on
  // every render so we always read the freshest awareness. The dep here is
  // intentional: we want the effect's bump to drive a re-render and the
  // recompute to happen on that render.
  void version

  const arcStates = (arcAwareness?.getStates() as Map<number, unknown> | undefined) ?? null
  const sessionStates = (sessionAwareness?.getStates() as Map<number, unknown> | undefined) ?? null
  const composed = composeAwareness(sessionStates, arcStates)
  if (!localUserId) return composed
  return composed.filter((p) => p.userId !== localUserId)
}
