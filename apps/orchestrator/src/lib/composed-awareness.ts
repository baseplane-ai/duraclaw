/**
 * GH#152 P1.6 (B16) — merge awareness state from the per-arc and
 * per-session collab DOs into a single per-user view.
 *
 * Two DOs coexist (`SessionCollabDOv2` + `ArcCollabDO`); a user sitting
 * on a session-bearing arc surface is connected to both. This pure
 * function joins the two awareness `Map<clientId, state>` views by
 * `state.user.id` and resolves a single (viewing, typing, color, name)
 * tuple per user. UI components render the result without caring which
 * DO contributed which field.
 *
 * Resolution rules:
 *   - `viewing` — arc state wins if its `viewing` field is set; otherwise
 *     fall back to session state's implicit `'transcript'` (when an
 *     `activeSessionId` is set, the user is by definition viewing the
 *     transcript of that session); otherwise `'unknown'`.
 *   - `typing` — OR'd across both DOs; either composer counts.
 *   - `displayName` / `color` — first non-empty wins, arc preferred.
 *   - `userId` — required; entries without it are skipped.
 *
 * Return order is stable: sort by displayName then userId so consumers
 * don't tear on Map iteration order changes.
 *
 * The local user is NOT filtered here — the caller passes filter logic
 * via the hook layer (`useArcPresence` filters using `selfClientId` /
 * the auth user id). Keeping this function pure and total makes it
 * trivially testable.
 */

export type Viewing = 'transcript' | 'chat' | 'inbox' | 'unknown'

export interface ComposedPresence {
  /** Stable across the merge — always the user id. */
  userId: string
  displayName: string
  color: string
  /**
   * Best-known "where is this user looking right now". Comes from arc
   * awareness `viewing` if set; otherwise from session awareness's
   * `activeSessionId` mapped to 'transcript'; otherwise 'unknown'.
   */
  viewing: Viewing
  /** OR of typing state across both DOs. */
  typing: boolean
  /** Session client id, if present (debug). */
  sessionClientId?: number
  /** Arc client id, if present (debug). */
  arcClientId?: number
}

interface AwarenessUserField {
  id?: unknown
  name?: unknown
  color?: unknown
}

interface ArcAwarenessState {
  user?: AwarenessUserField
  typing?: unknown
  viewing?: unknown
  activeArcId?: unknown
}

interface SessionAwarenessState {
  user?: AwarenessUserField
  typing?: unknown
  activeSessionId?: unknown
}

const VIEWING_VALUES: ReadonlySet<Viewing> = new Set(['transcript', 'chat', 'inbox', 'unknown'])

function isViewing(v: unknown): v is Viewing {
  return typeof v === 'string' && VIEWING_VALUES.has(v as Viewing)
}

function strOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

interface Accumulator {
  userId: string
  displayName: string
  color: string
  viewing: Viewing
  typing: boolean
  sessionClientId?: number
  arcClientId?: number
}

export function composeAwareness(
  sessionStates: Map<number, unknown> | null,
  arcStates: Map<number, unknown> | null,
): ComposedPresence[] {
  const byUser = new Map<string, Accumulator>()

  // Walk session states first — arc state can override fields below.
  if (sessionStates) {
    for (const [clientId, raw] of sessionStates) {
      const state = (raw ?? {}) as SessionAwarenessState
      const userId = strOrEmpty(state.user?.id)
      if (!userId) continue
      const existing = byUser.get(userId)
      const sessionTyping = state.typing === true
      const sessionViewing: Viewing =
        typeof state.activeSessionId === 'string' && state.activeSessionId.length > 0
          ? 'transcript'
          : 'unknown'
      if (!existing) {
        byUser.set(userId, {
          userId,
          displayName: strOrEmpty(state.user?.name) || 'Anonymous',
          color: strOrEmpty(state.user?.color) || '#94a3b8',
          viewing: sessionViewing,
          typing: sessionTyping,
          sessionClientId: clientId,
        })
      } else {
        existing.typing = existing.typing || sessionTyping
        // Only upgrade viewing from 'unknown' — arc state hasn't written
        // yet, so session's 'transcript' is the strongest signal so far.
        if (existing.viewing === 'unknown' && sessionViewing !== 'unknown') {
          existing.viewing = sessionViewing
        }
        if (existing.sessionClientId === undefined) existing.sessionClientId = clientId
      }
    }
  }

  if (arcStates) {
    for (const [clientId, raw] of arcStates) {
      const state = (raw ?? {}) as ArcAwarenessState
      const userId = strOrEmpty(state.user?.id)
      if (!userId) continue
      const arcTyping = state.typing === true
      const arcViewing: Viewing | null = isViewing(state.viewing) ? state.viewing : null
      const existing = byUser.get(userId)
      if (!existing) {
        byUser.set(userId, {
          userId,
          displayName: strOrEmpty(state.user?.name) || 'Anonymous',
          color: strOrEmpty(state.user?.color) || '#94a3b8',
          viewing: arcViewing ?? 'unknown',
          typing: arcTyping,
          arcClientId: clientId,
        })
      } else {
        // Arc fields override per the contract.
        const arcName = strOrEmpty(state.user?.name)
        const arcColor = strOrEmpty(state.user?.color)
        if (arcName) existing.displayName = arcName
        if (arcColor) existing.color = arcColor
        existing.typing = existing.typing || arcTyping
        // Arc viewing wins when it's a real (non-unknown) value; otherwise
        // keep whatever session contributed.
        if (arcViewing !== null && arcViewing !== 'unknown') {
          existing.viewing = arcViewing
        } else if (existing.viewing === 'unknown' && arcViewing !== null) {
          existing.viewing = arcViewing
        }
        if (existing.arcClientId === undefined) existing.arcClientId = clientId
      }
    }
  }

  const out: ComposedPresence[] = []
  for (const acc of byUser.values()) {
    const entry: ComposedPresence = {
      userId: acc.userId,
      displayName: acc.displayName,
      color: acc.color,
      viewing: acc.viewing,
      typing: acc.typing,
    }
    if (acc.sessionClientId !== undefined) entry.sessionClientId = acc.sessionClientId
    if (acc.arcClientId !== undefined) entry.arcClientId = acc.arcClientId
    out.push(entry)
  }
  out.sort((a, b) => {
    if (a.displayName !== b.displayName) {
      return a.displayName < b.displayName ? -1 : 1
    }
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0
  })
  return out
}
