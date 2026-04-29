/**
 * ArcStatusItem — StatusBar widget for kata-linked (arc) sessions.
 *
 * Spec: planning/specs/116-arcs-first-class-parent.md (B14). Renamed
 * from `ChainStatusItem` in P1.4. The "kata: <currentMode>/<currentPhase>"
 * label is INTENTIONALLY PRESERVED — kata UI labels stay per the
 * interview decision; the rename is an identifier sweep, not a
 * methodology purge.
 *
 * Renders a rung ladder (research → planning → impl → verify → close)
 * reflecting arc progress (NOT the viewed session's position). Clicking
 * a rung with a backing session rebinds the current tab to that session.
 * The popover exposes the auto-advance toggle that writes through
 * `userPreferencesCollection` (per-arc override, falling back to the
 * global `defaultChainAutoAdvance`). The toggle's preference shape is
 * still keyed by the arc's GH issue number for now (P1.4 sweep is
 * identifier-only; preference-shape migration is out of scope).
 *
 * Stall indicator (B9): P2 has no server-pushed `chain_stalled` event yet
 * (P3). Until then, on mount we recompute the client-side precondition
 * when the viewed session is `completed` and auto-advance is ON, to
 * approximate the diagnostic signal.
 */

import type { KataSessionState } from '@duraclaw/shared-types'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { arcsCollection } from '~/db/arcs-collection'
import { useArcAutoAdvance } from '~/hooks/use-arc-auto-advance'
import { checkPrecondition } from '~/hooks/use-arc-preconditions'
import { useTabSync } from '~/hooks/use-tab-sync'
import { deriveColumn, type KanbanColumn } from '~/lib/arcs'
import { CORE_RUNG_ORDER, type CoreRung } from '~/lib/auto-advance'
import { useStallReason } from '~/lib/chain-stall-store'
import { isChainSessionCompleted } from '~/lib/chains'
import type { ArcSummary } from '~/lib/types'

interface ArcStatusItemProps {
  kataState: KataSessionState
  kataIssue: number
  sessionId: string
}

const RUNG_LABELS: Record<CoreRung, string> = {
  research: 'research',
  planning: 'planning',
  implementation: 'impl',
  verify: 'verify',
  close: 'close',
}

type RungState = 'completed' | 'current' | 'future'

interface RungInfo {
  rung: CoreRung
  state: RungState
  /** Most-recent session for this rung, if any. */
  targetSessionId: string | null
  /** True when the viewed session's mode matches this rung. */
  viewing: boolean
  /** Session status (running/idle/completed/failed/etc) for targetSessionId. */
  targetStatus: string | null
}

const GH_REPO = 'baseplane-ai/duraclaw'

/**
 * Statuses that mean "runner still attached / awaiting user or gate input".
 * Mirrors `isLiveStatus` in apps/orchestrator/src/components/layout/nav-sessions.tsx
 * (lines 714-722). `'idle'` is intentionally excluded — an idle session has
 * parked after a turn and is NOT the active frontier for rung rendering.
 */
const ACTIVE_STATUSES = new Set(['running', 'waiting_input', 'waiting_permission', 'waiting_gate'])

/** Map an arc's derived `column` to the rung that represents the active frontier. */
function columnToRung(column: KanbanColumn): CoreRung | null {
  switch (column) {
    case 'research':
      return 'research'
    case 'planning':
      return 'planning'
    case 'implementation':
      return 'implementation'
    case 'verify':
      return 'verify'
    case 'done':
      return 'close'
    default:
      return null
  }
}

function parseLastActivity(iso: string | null): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

function computeRungs(arc: ArcSummary, sessionId: string, column: KanbanColumn): RungInfo[] {
  // Sessions for each rung, newest-first by lastActivity.
  const byRung: Record<CoreRung, ArcSummary['sessions']> = {
    research: [],
    planning: [],
    implementation: [],
    verify: [],
    close: [],
  }
  for (const s of arc.sessions) {
    if (s.mode && (CORE_RUNG_ORDER as readonly string[]).includes(s.mode)) {
      byRung[s.mode as CoreRung].push(s)
    }
  }
  for (const rung of CORE_RUNG_ORDER) {
    byRung[rung].sort(
      (a, b) => parseLastActivity(b.lastActivity) - parseLastActivity(a.lastActivity),
    )
  }

  // Prefer the rung corresponding to the most-recent non-terminal session;
  // fall back to the column-derived rung.
  const allSessions = [...arc.sessions]
    .filter((s) => s.mode && (CORE_RUNG_ORDER as readonly string[]).includes(s.mode))
    .sort((a, b) => parseLastActivity(b.lastActivity) - parseLastActivity(a.lastActivity))
  // Frontier = most-recent session whose runner is still attached / awaiting
  // input. `'idle'` is the D1 terminal marker for "turn finished, parked",
  // so idle sessions are NOT the frontier — only `ACTIVE_STATUSES` qualify.
  const activeSession = allSessions.find((s) => ACTIVE_STATUSES.has(s.status))
  const activeRung: CoreRung | null =
    (activeSession?.mode as CoreRung | undefined) ?? columnToRung(column)

  return CORE_RUNG_ORDER.map((rung) => {
    const list = byRung[rung]
    const mostRecent = list[0] ?? null
    // 'idle' is the D1 terminal marker; see isChainSessionCompleted above.
    const completed = list.some((s) =>
      isChainSessionCompleted({ status: s.status, lastActivity: s.lastActivity }),
    )
    const isActiveFrontier = activeRung === rung
    let state: RungState
    if (completed && !isActiveFrontier) state = 'completed'
    else if (isActiveFrontier) state = 'current'
    else state = completed ? 'completed' : 'future'

    const viewing = list.some((s) => s.id === sessionId)
    return {
      rung,
      state,
      targetSessionId: mostRecent?.id ?? null,
      viewing,
      targetStatus: mostRecent?.status ?? null,
    }
  })
}

export function ArcStatusItem({ kataState, kataIssue, sessionId }: ArcStatusItemProps) {
  const [showPopover, setShowPopover] = useState(false)
  // Mount-time re-evaluation of the precondition — a conservative fallback
  // when the client hasn't yet received a server-pushed `chain_stalled`.
  const [mountReevalStallReason, setMountReevalStallReason] = useState<string | null>(null)
  // DO-pushed stall reason from `chain_stalled` WS events (written into
  // chain-stall-store by use-coding-agent's handler). Authoritative when
  // present; falls back to the mount re-eval otherwise.
  const wsStallReason = useStallReason(kataIssue)
  const stallReason = wsStallReason ?? mountReevalStallReason

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: arcsData } = useLiveQuery(arcsCollection as any)

  const { replaceTab } = useTabSync()

  const arc = useMemo<ArcSummary | null>(() => {
    if (!arcsData) return null
    const arr = arcsData as ArcSummary[]
    // Lookup is still keyed by GH issue number — preserves StatusBar's
    // existing kataIssue-based wiring. The arc's externalRef carries
    // the GH issue id; non-GitHub arcs (linear/plain) won't match a
    // numeric kataIssue, which is the correct behavior.
    return (
      arr.find(
        (a) => a.externalRef?.provider === 'github' && Number(a.externalRef.id) === kataIssue,
      ) ?? null
    )
  }, [arcsData, kataIssue])

  const { enabled: autoAdvanceOn, toggle: onToggleAutoAdvance } = useArcAutoAdvance(kataIssue)

  const column = useMemo<KanbanColumn>(() => {
    if (!arc) return 'backlog'
    return deriveColumn(arc.sessions, arc.status)
  }, [arc])

  const rungs = useMemo<RungInfo[]>(() => {
    if (!arc) return []
    return computeRungs(arc, sessionId, column)
  }, [arc, sessionId, column])

  const isArcComplete = useMemo(() => {
    if (!arc) return false
    if (column !== 'done') return false
    return rungs.every((r) => {
      // arc-complete means all 5 rungs have a completed session.
      // 'idle' is the D1 terminal marker (see isChainSessionCompleted).
      return arc.sessions.some(
        (s) =>
          s.mode === r.rung &&
          isChainSessionCompleted({ status: s.status, lastActivity: s.lastActivity }),
      )
    })
  }, [arc, column, rungs])

  // Stall re-evaluation on mount / when inputs change (B9 fallback).
  // Authoritative signal is the WS-pushed `chain_stalled` event (see
  // `wsStallReason` above); this re-eval only matters when the user
  // reloads onto a parked session and missed the original push.
  useEffect(() => {
    let cancelled = false
    setMountReevalStallReason(null)
    if (!arc) return
    if (column === 'done') return
    if (!autoAdvanceOn) return
    const currentSession = arc.sessions.find((s) => s.id === sessionId)
    // 'idle' is the D1 terminal marker; see nav-sessions.tsx:isCompletedSession.
    // Only re-run the precondition once the viewed session has entered the
    // parked/terminal state.
    if (!currentSession || currentSession.status !== 'idle') return
    void checkPrecondition(arc).then((res) => {
      if (cancelled) return
      if (!res.canAdvance && res.reason) {
        setMountReevalStallReason(res.reason)
      }
    })
    return () => {
      cancelled = true
    }
  }, [arc, column, sessionId, autoAdvanceOn])

  const onJumpRung = useCallback(
    (target: string | null) => {
      if (!target) return
      if (target === sessionId) return
      replaceTab(sessionId, target)
      setShowPopover(false)
    },
    [replaceTab, sessionId],
  )

  if (!arc) {
    // No arc data loaded yet — fall through to a compact pill with just
    // the issue number; avoids flicker on first render. Kata UI label
    // PRESERVED per spec interview decision.
    return (
      <div className="relative">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setShowPopover(!showPopover)}
        >
          #{kataIssue} · kata: {kataState.currentMode}/{kataState.currentPhase || '—'}
        </button>
      </div>
    )
  }

  // Rung glyphs
  const glyphFor = (r: RungInfo, hasStall: boolean): string => {
    if (r.state === 'completed') return '●' // ●
    if (r.state === 'current') {
      if (hasStall) return '⚠' // ⚠ overlays current rung
      return '◐' // ◐
    }
    return '○' // ○ hollow
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        onClick={() => setShowPopover(!showPopover)}
        data-testid="arc-status-item"
      >
        <span className="rounded bg-muted px-1.5 py-0.5 text-foreground">#{kataIssue}</span>
        <span className="flex items-center gap-0.5">
          {rungs.map((r, idx) => {
            const isCurrent = r.state === 'current'
            const hasStall = isCurrent && !!stallReason
            const pulsate = isCurrent && r.targetStatus === 'running'
            const glyph = glyphFor(r, hasStall)
            const viewingClass = r.viewing ? 'underline' : ''
            const stallClass = hasStall ? 'text-amber-500' : ''
            const currentClass = isCurrent && !hasStall ? 'text-foreground font-semibold' : ''
            const completedClass = r.state === 'completed' ? 'text-foreground' : ''
            const futureClass = r.state === 'future' ? 'text-muted-foreground/60' : ''
            const pulseClass = pulsate ? 'animate-pulse' : ''
            return (
              <span key={r.rung} className="flex items-center">
                <span
                  className={`inline-flex items-center gap-0.5 px-0.5 ${viewingClass} ${stallClass} ${currentClass} ${completedClass} ${futureClass} ${pulseClass}`}
                  title={hasStall ? `Stalled: ${stallReason}` : undefined}
                >
                  <span>{glyph}</span>
                  <span>{RUNG_LABELS[r.rung]}</span>
                </span>
                {idx < rungs.length - 1 && (
                  <span className="px-0.5 text-muted-foreground/50">→</span>
                )}
              </span>
            )
          })}
        </span>
        {isArcComplete && <span className="ml-1 text-green-500">Complete</span>}
      </button>
      {showPopover && (
        <div className="absolute bottom-full left-0 mb-1 w-72 rounded border bg-popover p-3 text-popover-foreground shadow-md text-xs">
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <a
                href={`https://github.com/${GH_REPO}/issues/${kataIssue}`}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium underline-offset-2 hover:underline"
              >
                #{kataIssue} {arc.title}
              </a>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setShowPopover(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {arc.prNumber && (
              <div>
                <a
                  href={`https://github.com/${GH_REPO}/pull/${arc.prNumber}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-muted-foreground underline-offset-2 hover:underline"
                >
                  PR #{arc.prNumber}
                </a>
              </div>
            )}

            {arc.worktreeReservation && (
              <div className="text-muted-foreground">
                {/* GH#115: legacy `worktree` (project name) is the basename
                    of the new `worktree` field (e.g. /data/projects/duraclaw-dev3 ->
                    duraclaw-dev3). Falls back to the full path if the
                    derivation fails — never empty. */}
                Worktree:{' '}
                {arc.worktreeReservation.worktree.split('/').pop() ||
                  arc.worktreeReservation.worktree}
              </div>
            )}

            <div className="flex flex-col gap-1 border-t pt-2">
              {rungs.map((r) => {
                const hasTarget = !!r.targetSessionId
                const isCurrentlyViewing = r.viewing
                const clickable = hasTarget && !isCurrentlyViewing
                const glyph = r.state === 'completed' ? '●' : r.state === 'current' ? '◐' : '○'
                const rowBase = 'flex w-full items-center justify-between gap-2 rounded px-1 py-0.5'
                if (clickable) {
                  return (
                    <button
                      key={r.rung}
                      type="button"
                      className={`${rowBase} hover:bg-muted text-left`}
                      onClick={() => onJumpRung(r.targetSessionId)}
                    >
                      <span className="flex items-center gap-1.5">
                        <span>{glyph}</span>
                        <span>{RUNG_LABELS[r.rung]}</span>
                      </span>
                      {r.targetStatus && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                          {r.targetStatus}
                        </span>
                      )}
                    </button>
                  )
                }
                return (
                  <div
                    key={r.rung}
                    className={`${rowBase} ${isCurrentlyViewing ? 'font-semibold underline' : 'text-muted-foreground/70'}`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span>{glyph}</span>
                      <span>{RUNG_LABELS[r.rung]}</span>
                    </span>
                    {r.targetStatus ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                        {r.targetStatus}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </div>
                )
              })}
            </div>

            {stallReason && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-600">
                Stalled: {stallReason}
              </div>
            )}

            {!isArcComplete && (
              <label className="flex cursor-pointer items-center gap-2 border-t pt-2">
                <input
                  type="checkbox"
                  checked={autoAdvanceOn}
                  onChange={onToggleAutoAdvance}
                  className="h-3 w-3"
                />
                <span>Auto-advance this arc</span>
              </label>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
