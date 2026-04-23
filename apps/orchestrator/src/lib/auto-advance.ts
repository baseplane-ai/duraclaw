/**
 * Chain auto-advance (spec 16-chain-ux-p1-5 B6): server-side port of the
 * client-side precondition check (`~/hooks/use-chain-preconditions`)
 * plus the successor-spawn logic. Invoked from SessionDO when a chain-
 * linked session terminates.
 *
 * Invariants:
 *   - Only core rungs trigger auto-advance. `debug`, `freeform`, `task`,
 *     `onboard` are explicitly filtered out.
 *   - Honors per-chain + global user preferences. Default is OFF.
 *   - Idempotent — concurrent terminal events won't spawn duplicate
 *     successors (D1 SELECT guard on (kataIssue, nextMode)).
 *   - All gateway file lookups go through the VPS gateway (different
 *     service), never same-worker fetch — no DO-to-self-worker deadlock.
 */

import { and, eq, notInArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { agentSessions, userPreferences } from '~/db/schema'
import { checkoutWorktree } from '~/lib/checkout-worktree'
import { createSession } from '~/lib/create-session'
import type { Env } from '~/lib/types'

/**
 * The 5 "core" kata modes that form the linear advancement chain, in
 * ladder order. Consumers that need set-membership semantics should use
 * `CORE_RUNGS` (derived below); consumers that render the ladder in order
 * should iterate `CORE_RUNG_ORDER` directly.
 */
export const CORE_RUNG_ORDER = [
  'research',
  'planning',
  'implementation',
  'verify',
  'close',
] as const

export type CoreRung = (typeof CORE_RUNG_ORDER)[number]

/** The 5 "core" kata modes that form the linear advancement chain. */
export const CORE_RUNGS = new Set<string>(CORE_RUNG_ORDER)

/** Modes whose successor session takes ownership of a worktree. */
const CODE_TOUCHING_MODES = new Set<string>(['implementation', 'verify', 'debug', 'task'])

/**
 * Map a current core rung to its successor. `close` → null (end of chain).
 * Non-core rungs also return null so callers never accidentally auto-advance
 * out of a debug / freeform session.
 */
export function nextRung(current: string): string | null {
  switch (current) {
    case 'research':
      return 'planning'
    case 'planning':
      return 'implementation'
    case 'implementation':
      return 'verify'
    case 'verify':
      return 'close'
    case 'close':
      return null
    default:
      return null
  }
}

export type AutoAdvanceResult =
  | { action: 'none' }
  | { action: 'stalled'; reason: string }
  | { action: 'advanced'; newSessionId: string; nextMode: string }
  | { action: 'error'; error: string }

export interface TryAutoAdvanceParams {
  sessionId: string
  userId: string
  kataIssue: number
  kataMode: string
  project: string
  /**
   * GH#73: authoritative "rung finished" signal — `.kata/sessions/<sdk-
   * session-id>/run-end.json` was observed for the current session. Kata's
   * Stop hook writes it only when `can-exit` passes (no-op modes + all
   * stop conditions met) and skips it on block / background-agents-running.
   * This is the single gate; we no longer parse spec status or probe for
   * VP evidence through the gateway (both were fragile — a gateway hiccup
   * manifested as a permanent "spec not found" stall).
   */
  runEnded: boolean
}

/**
 * Read the effective auto-advance setting for a given chain (per-chain
 * override falls back to the user's global default).
 */
async function readAutoAdvancePref(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string,
  kataIssue: number,
): Promise<boolean> {
  const rows = await db
    .select({
      chainsJson: userPreferences.chainsJson,
      defaultChainAutoAdvance: userPreferences.defaultChainAutoAdvance,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1)
  const row = rows[0]
  if (!row) return false

  const globalDefault = !!row.defaultChainAutoAdvance
  if (!row.chainsJson) return globalDefault
  try {
    const parsed = JSON.parse(row.chainsJson) as Record<string, { autoAdvance?: boolean }>
    const entry = parsed?.[String(kataIssue)]
    if (entry && typeof entry.autoAdvance === 'boolean') return entry.autoAdvance
  } catch (err) {
    // malformed JSON → fall back to global default
    console.warn('[auto-advance] malformed chainsJson for user', userId, err)
  }
  return globalDefault
}

/**
 * Main entry point — called from `SessionDO.maybeAutoAdvanceChain()` when
 * a core-rung session terminates. Returns a discriminated result describing
 * what happened so the caller can emit the appropriate WS event.
 *
 * `executionCtx` is forwarded to `createSession` so its
 * `broadcastSessionRow` fanout lands on a real `ctx.waitUntil`. If omitted,
 * the broadcast is awaited inline by `createSession` (via the helper's own
 * waitUntil fallback) — prefer passing `this.ctx` from SessionDO.
 */
export async function tryAutoAdvance(
  env: Env,
  params: TryAutoAdvanceParams,
  executionCtx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<AutoAdvanceResult> {
  const { userId, kataIssue, kataMode, project, runEnded } = params

  if (!CORE_RUNGS.has(kataMode)) return { action: 'none' }
  const nextMode = nextRung(kataMode)
  if (nextMode === null) return { action: 'none' }

  const db = drizzle(env.AUTH_DB, { schema })

  // 1. User preference gate.
  const enabled = await readAutoAdvancePref(db, userId, kataIssue)
  if (!enabled) return { action: 'none' }

  // 2. Idempotency — already-spawned successor (concurrent completion race).
  const terminalStatuses = ['stopped', 'failed', 'crashed']
  const existing = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.kataIssue, kataIssue),
        eq(agentSessions.kataMode, nextMode),
        notInArray(agentSessions.status, terminalStatuses),
      ),
    )
    .limit(1)
  if (existing[0]) return { action: 'none' }

  // 3. Evidence-file gate (GH#73). Kata's Stop hook writes
  // `run-end.json` inside the SDK session folder when `can-exit` succeeds.
  // If the runner never observed that file for this session, the rung
  // didn't meet its stop conditions — don't advance. No spec/VP probes;
  // kata itself owns those checks as stop-conditions on each mode.
  if (!runEnded) {
    return {
      action: 'stalled',
      reason: 'Rung did not signal run-end (kata can-exit not satisfied)',
    }
  }

  // 4. Worktree checkout for code-touching successors.
  if (CODE_TOUCHING_MODES.has(nextMode)) {
    try {
      const co = await checkoutWorktree(
        db,
        { issueNumber: kataIssue, worktree: project, modeAtCheckout: nextMode },
        userId,
      )
      if (!co.ok) {
        if (co.status === 409) {
          return {
            action: 'stalled',
            reason: `Worktree held by chain #${co.conflict.issueNumber}`,
          }
        }
        return { action: 'error', error: co.error }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { action: 'error', error: `Worktree checkout failed: ${msg}` }
    }
  }

  // 5. Spawn the successor session. When the caller (SessionDO) provides
  // its `this.ctx` we forward it so `broadcastSessionRow` runs under a
  // real `ctx.waitUntil`; otherwise fall back to an inline-await shim so
  // the broadcast still settles.
  const spawnCtx = executionCtx ?? {
    waitUntil: (p: Promise<unknown>) => {
      void p.catch((err) => console.warn('[auto-advance] broadcast failed', err))
    },
  }
  try {
    const result = await createSession(
      env,
      userId,
      {
        project,
        prompt: `enter ${nextMode}`,
        model: 'sonnet',
        agent: nextMode,
        kataIssue,
      },
      spawnCtx,
    )
    if (!result.ok) {
      return { action: 'error', error: result.error }
    }
    return { action: 'advanced', newSessionId: result.sessionId, nextMode }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { action: 'error', error: msg }
  }
}
