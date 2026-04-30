/**
 * advanceArc — kanban "Start next" / drag-to-advance helper.
 *
 * GH#116 P4a: replaces the legacy advanceChain flow. Calls
 * `POST /api/arcs/:id/sessions` (the advanceArc primitive — body
 * `{mode, prompt, project?}`); the server picks the frontier session,
 * closes it, and mints a successor with the right `arcId` /
 * `parentSessionId` stamping. The client no longer aborts the active
 * session itself.
 *
 * The legacy `/api/chains/:issue/checkout` step is gone — worktree
 * reservation is now driven by the arc's `worktreeId` FK (set up via
 * `POST /api/worktrees` separately, or carried over by an existing
 * arc). Backlog-bootstrap callers (an arc with zero sessions) may pass
 * `projectOverride` so the server can mint the first session without a
 * prior project to inherit.
 *
 * No collection mutations — the new session shows up via WS deltas
 * pushed against `arcsCollection` and `sessionsCollection`.
 */

import { apiUrl } from '~/lib/platform'
import type { ArcSummary } from '~/lib/types'

const ACTIVE_STATUSES = new Set(['running', 'waiting_input', 'waiting_permission', 'idle'])

export type AdvanceArcResult =
  | { ok: true; sessionId: string; arcId: string }
  | { ok: false; error?: string }

function latestActiveSession(arc: ArcSummary): ArcSummary['sessions'][number] | null {
  const active = arc.sessions.filter((s) => ACTIVE_STATUSES.has(String(s.status)))
  if (active.length === 0) return null
  const sorted = [...active].sort((a, b) => {
    const aTime = new Date(a.lastActivity ?? a.createdAt).getTime()
    const bTime = new Date(b.lastActivity ?? b.createdAt).getTime()
    return bTime - aTime
  })
  return sorted[0] ?? null
}

/**
 * Fallback worktree label used by the AdvanceConfirmModal display.
 * ArcSummary's `worktreeReservation.worktree` is the full path — the
 * UI shows the basename. Returns null when there's no reservation.
 */
export function arcWorktreeLabel(arc: ArcSummary): string | null {
  return arc.worktreeReservation?.worktree.split('/').pop() ?? null
}

/**
 * POST /api/arcs/:id/sessions advance helper. The server-side
 * primitive picks the frontier session and mints a successor; the
 * client just supplies `mode` (the new mode) and `prompt` (the
 * preamble / kata-enter line).
 */
export async function advanceArc(
  arc: ArcSummary,
  nextMode: string,
  options?: { projectOverride?: string | null },
): Promise<AdvanceArcResult> {
  // The kata enter prompt mirrors the legacy advance-chain helper —
  // the runner needs an explicit "enter <mode>" line so kata picks up
  // the new mode. For non-GH arcs we omit the `--issue=` flag.
  const issueId =
    arc.externalRef?.provider === 'github' && typeof arc.externalRef.id === 'number'
      ? arc.externalRef.id
      : null
  const prompt = issueId !== null ? `enter ${nextMode} --issue=${issueId}` : `enter ${nextMode}`

  const body: { mode: string; prompt: string; project?: string } = { mode: nextMode, prompt }
  if (options?.projectOverride) body.project = options.projectOverride

  try {
    const resp = await fetch(apiUrl(`/api/arcs/${arc.id}/sessions`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const body = (await resp.json().catch(() => null)) as { error?: string } | null
      return { ok: false, error: body?.error ?? `Advance failed: ${resp.status}` }
    }
    const json = (await resp.json()) as { sessionId?: string; arcId?: string }
    if (!json.sessionId || !json.arcId) {
      return { ok: false, error: 'Advance returned no sessionId' }
    }
    return { ok: true, sessionId: json.sessionId, arcId: json.arcId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Exported for Start-next button to decide its label. */
export function hasActiveSession(arc: ArcSummary): boolean {
  return latestActiveSession(arc) !== null
}
