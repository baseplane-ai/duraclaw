/**
 * ChainStatusItem — StatusBar widget for kata-linked (chain) sessions.
 *
 * Spec: planning/specs/16-chain-ux-p1-5.md (B3, B4, B5, B8, B9).
 *
 * Renders a rung ladder (research → planning → impl → verify → close)
 * reflecting chain progress (NOT the viewed session's position). Clicking
 * a rung with a backing session rebinds the current tab to that session.
 * The popover exposes the auto-advance toggle that writes through
 * `userPreferencesCollection` (per-chain override, falling back to the
 * global `defaultChainAutoAdvance`).
 *
 * Stall indicator (B9): P2 has no server-pushed `chain_stalled` event yet
 * (P3). Until then, on mount we recompute the client-side precondition
 * when the viewed session is `completed` and auto-advance is ON, to
 * approximate the diagnostic signal.
 */

import type { KataSessionState } from '@duraclaw/shared-types'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { chainsCollection } from '~/db/chains-collection'
import { useChainAutoAdvance } from '~/hooks/use-chain-auto-advance'
import { checkPrecondition } from '~/hooks/use-chain-preconditions'
import { useTabSync } from '~/hooks/use-tab-sync'
import { CORE_RUNG_ORDER, type CoreRung } from '~/lib/auto-advance'
import { useStallReason } from '~/lib/chain-stall-store'
import { isChainSessionCompleted } from '~/lib/chains'
import type { ChainSummary } from '~/lib/types'

interface ChainStatusItemProps {
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
  /** True when the viewed session's kataMode matches this rung. */
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

/** Map a chain's derived `column` to the rung that represents the active frontier. */
function columnToRung(column: ChainSummary['column']): CoreRung | null {
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

function computeRungs(chain: ChainSummary, sessionId: string): RungInfo[] {
  // Sessions for each rung, newest-first by lastActivity.
  const byRung: Record<CoreRung, ChainSummary['sessions']> = {
    research: [],
    planning: [],
    implementation: [],
    verify: [],
    close: [],
  }
  for (const s of chain.sessions) {
    if (s.kataMode && (CORE_RUNG_ORDER as readonly string[]).includes(s.kataMode)) {
      byRung[s.kataMode as CoreRung].push(s)
    }
  }
  for (const rung of CORE_RUNG_ORDER) {
    byRung[rung].sort(
      (a, b) => parseLastActivity(b.lastActivity) - parseLastActivity(a.lastActivity),
    )
  }

  // Prefer the rung corresponding to the most-recent non-terminal session;
  // fall back to the chain.column-derived rung.
  const allSessions = [...chain.sessions]
    .filter((s) => s.kataMode && (CORE_RUNG_ORDER as readonly string[]).includes(s.kataMode))
    .sort((a, b) => parseLastActivity(b.lastActivity) - parseLastActivity(a.lastActivity))
  // Frontier = most-recent session whose runner is still attached / awaiting
  // input. `'idle'` is the D1 terminal marker for "turn finished, parked",
  // so idle sessions are NOT the frontier — only `ACTIVE_STATUSES` qualify.
  const activeSession = allSessions.find((s) => ACTIVE_STATUSES.has(s.status))
  const activeRung: CoreRung | null =
    (activeSession?.kataMode as CoreRung | undefined) ?? columnToRung(chain.column)

  return CORE_RUNG_ORDER.map((rung) => {
    const list = byRung[rung]
    const mostRecent = list[0] ?? null
    // 'idle' is the D1 terminal marker; see isChainSessionCompleted above.
    const completed = list.some(isChainSessionCompleted)
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

export function ChainStatusItem({ kataState, kataIssue, sessionId }: ChainStatusItemProps) {
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
  const { data: chainsData } = useLiveQuery(chainsCollection as any)

  const { replaceTab } = useTabSync()

  const chain = useMemo<ChainSummary | null>(() => {
    if (!chainsData) return null
    const arr = chainsData as ChainSummary[]
    return arr.find((c) => c.issueNumber === kataIssue) ?? null
  }, [chainsData, kataIssue])

  const { enabled: autoAdvanceOn, toggle: onToggleAutoAdvance } = useChainAutoAdvance(kataIssue)

  const rungs = useMemo<RungInfo[]>(() => {
    if (!chain) return []
    return computeRungs(chain, sessionId)
  }, [chain, sessionId])

  const isChainComplete = useMemo(() => {
    if (!chain) return false
    if (chain.column !== 'done') return false
    return rungs.every((r) => {
      // chain-complete means all 5 rungs have a completed session.
      // 'idle' is the D1 terminal marker (see isChainSessionCompleted).
      return chain.sessions.some((s) => s.kataMode === r.rung && isChainSessionCompleted(s))
    })
  }, [chain, rungs])

  // Stall re-evaluation on mount / when inputs change (B9 fallback).
  // Authoritative signal is the WS-pushed `chain_stalled` event (see
  // `wsStallReason` above); this re-eval only matters when the user
  // reloads onto a parked session and missed the original push.
  useEffect(() => {
    let cancelled = false
    setMountReevalStallReason(null)
    if (!chain) return
    if (chain.column === 'done') return
    if (!autoAdvanceOn) return
    const currentSession = chain.sessions.find((s) => s.id === sessionId)
    // 'idle' is the D1 terminal marker; see nav-sessions.tsx:isCompletedSession.
    // Only re-run the precondition once the viewed session has entered the
    // parked/terminal state.
    if (!currentSession || currentSession.status !== 'idle') return
    void checkPrecondition(chain, chain.sessions).then((res) => {
      if (cancelled) return
      if (!res.canAdvance && res.reason) {
        setMountReevalStallReason(res.reason)
      }
    })
    return () => {
      cancelled = true
    }
  }, [chain, sessionId, autoAdvanceOn])

  const onJumpRung = useCallback(
    (target: string | null) => {
      if (!target) return
      if (target === sessionId) return
      replaceTab(sessionId, target)
      setShowPopover(false)
    },
    [replaceTab, sessionId],
  )

  if (!chain) {
    // No chain data loaded yet — fall through to a compact pill with just
    // the issue number; avoids flicker on first render.
    return (
      <div className="relative">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setShowPopover(!showPopover)}
        >
          #{kataIssue} · kata: {kataState.currentMode}/{kataState.currentPhase || '\u2014'}
        </button>
      </div>
    )
  }

  // Rung glyphs
  const glyphFor = (r: RungInfo, hasStall: boolean): string => {
    if (r.state === 'completed') return '\u25CF' // ●
    if (r.state === 'current') {
      if (hasStall) return '\u26A0' // ⚠ overlays current rung
      return '\u25D0' // ◐
    }
    return '\u25CB' // ○ hollow
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        onClick={() => setShowPopover(!showPopover)}
        data-testid="chain-status-item"
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
        {isChainComplete && <span className="ml-1 text-green-500">Complete</span>}
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
                #{kataIssue} {chain.issueTitle}
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

            {chain.prNumber && (
              <div>
                <a
                  href={`https://github.com/${GH_REPO}/pull/${chain.prNumber}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-muted-foreground underline-offset-2 hover:underline"
                >
                  PR #{chain.prNumber}
                </a>
              </div>
            )}

            {chain.worktreeReservation && (
              <div className="text-muted-foreground">
                {/* GH#115: legacy `worktree` (project name) is the basename
                    of the new `path` (e.g. /data/projects/duraclaw-dev3 ->
                    duraclaw-dev3). Falls back to the full path if the
                    derivation fails — never empty. */}
                Worktree:{' '}
                {chain.worktreeReservation.path.split('/').pop() || chain.worktreeReservation.path}
              </div>
            )}

            <div className="flex flex-col gap-1 border-t pt-2">
              {rungs.map((r) => {
                const hasTarget = !!r.targetSessionId
                const isCurrentlyViewing = r.viewing
                const clickable = hasTarget && !isCurrentlyViewing
                const glyph =
                  r.state === 'completed' ? '\u25CF' : r.state === 'current' ? '\u25D0' : '\u25CB'
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

            {!isChainComplete && (
              <label className="flex cursor-pointer items-center gap-2 border-t pt-2">
                <input
                  type="checkbox"
                  checked={autoAdvanceOn}
                  onChange={onToggleAutoAdvance}
                  className="h-3 w-3"
                />
                <span>Auto-advance this chain</span>
              </label>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
