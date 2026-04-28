import { eq } from 'drizzle-orm'
import { agentSessions } from '~/db/schema'
import { broadcastSessionRow } from '~/lib/broadcast-session'
import type { SessionDOContext } from './types'

/**
 * Title-source priority. The DO's never-clobber invariant: a `'user'` title
 * source freezes the title forever. Adding a new source (e.g. voice-name)
 * is a single-line edit here, not a multi-site audit.
 */
export type TitleSource = 'user' | 'haiku' | null

/**
 * Decide whether to accept an incoming title update.
 *
 * Spec #101 B6: replaces the inline `if (title_source === 'user') break`
 * never-clobber check with a typed policy function. Adding new title
 * sources requires updating this function only — not auditing every
 * `case 'title_update':` handler call site.
 *
 * Current policy:
 *   - `currentSource === 'user'` → reject (user title is sticky)
 *   - otherwise → accept (haiku may overwrite haiku/null)
 *
 * `currentConfidence` / `incomingConfidence` are accepted for forward
 * compatibility (future "higher-confidence-wins" tiebreakers); unused today.
 */
export function titleResolutionPolicy(
  currentSource: TitleSource,
  _currentConfidence: number | null | undefined,
  _incomingSource: Exclude<TitleSource, null>,
  _incomingConfidence: number | null | undefined,
): 'accept' | 'reject' {
  if (currentSource === 'user') return 'reject'
  return 'accept'
}

interface TitleUpdateEventLike {
  type: 'title_update'
  title: string
  confidence: number
  turn_stamp: number
}

/**
 * Handle a `title_update` GatewayEvent.
 *
 * GH#86: Haiku-generated session title. Runner emits this after a
 * successful Haiku call (initial title or pivot retitle). Applies iff
 * `titleResolutionPolicy` says `'accept'`, persists to session_meta + D1,
 * and broadcasts via `broadcastSessionRow`.
 */
export function handleTitleUpdate(ctx: SessionDOContext, event: TitleUpdateEventLike): void {
  const decision = titleResolutionPolicy(
    ctx.state.title_source ?? null,
    ctx.state.title_confidence ?? null,
    'haiku',
    event.confidence,
  )
  if (decision === 'reject') {
    ctx.logEvent('info', 'titler', `title_update rejected (frozen by user rename)`, {
      incoming_title: event.title,
      incoming_confidence: event.confidence,
    })
    console.log(`[SessionDO:${ctx.ctx.id}] title_update discarded: title_source='user'`)
    return
  }

  // Success path — log here so the per-DO event_log records every title
  // landing without us having to SSH to the VPS for runner logs.
  ctx.logEvent(
    'info',
    'titler',
    `title accepted: "${event.title}" (conf=${event.confidence.toFixed(2)})`,
    {
      title: event.title,
      confidence: event.confidence,
      turn_stamp: event.turn_stamp,
      source: 'haiku',
    },
  )

  ctx.do.updateState({
    title: event.title,
    title_confidence: event.confidence,
    title_set_at_turn: event.turn_stamp,
    title_source: 'haiku',
  })

  // D1 write then broadcast — chained inside a single waitUntil so
  // the D1 write completes before broadcastSessionRow reads the row.
  const sessionId = ctx.do.name
  const now = new Date().toISOString()
  ctx.ctx.waitUntil(
    ctx.do.d1
      .update(agentSessions)
      .set({
        title: event.title,
        titleSource: 'haiku',
        updatedAt: now,
      })
      .where(eq(agentSessions.id, sessionId))
      .then(() => broadcastSessionRow(ctx.env, ctx.ctx, sessionId, 'update'))
      .catch((err) => {
        console.error(`[SessionDO:${ctx.ctx.id}] title_update D1 sync failed:`, err)
      }),
  )
}
