/**
 * Sidebar session-list filter predicate.
 *
 * Spec #68 B11 — client-side filter between "all sessions" (server default,
 * includes public sessions from other users) and "mine" (only sessions
 * owned by the current user). Keep this a pure function so it's trivial
 * to unit-test without mounting NavSessions.
 */

import type { SessionRecord } from '~/db/session-record'

export type SessionFilterMode = 'all' | 'mine'

export function filterSessionsByMode(
  sessions: SessionRecord[],
  mode: SessionFilterMode,
  currentUserId: string | null,
): SessionRecord[] {
  if (mode === 'all' || !currentUserId) return sessions
  return sessions.filter((s) => s.userId === currentUserId)
}
