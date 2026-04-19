/**
 * advanceChain — the degraded-path mode-transition helper used by the
 * kanban Start-next button and by drag-to-advance (B9 / B10).
 *
 * Without P4's B5 mode-reset in place, the "advance" is: if the chain
 * currently has an active (non-terminal) session, abort it, then spawn a
 * fresh session for `nextMode`. When P4 lands this helper gets swapped
 * for the B5 preamble flow; call sites don't change.
 *
 * No collection mutations here — the new session will appear in
 * sessionLiveStateCollection via its normal seeding / refresh flow.
 * The caller is expected to toast success and navigate.
 */

import type { ChainSummary, WorktreeReservation } from '~/lib/types'

const ACTIVE_STATUSES = new Set(['running', 'waiting_input', 'waiting_permission', 'idle'])

/**
 * Code-touching kata modes that require an exclusive worktree checkout
 * before a session may spawn (spec 16-chain-ux B11). `research` and
 * `planning` are read-only and skip the checkout gate.
 */
const CODE_TOUCHING_MODES = new Set(['implementation', 'verify', 'debug', 'task'])

export type AdvanceChainResult =
  | { ok: true; sessionId: string }
  | { ok: false; error?: string; conflict?: WorktreeReservation }

function latestActiveSession(chain: ChainSummary): ChainSummary['sessions'][number] | null {
  const active = chain.sessions.filter((s) => ACTIVE_STATUSES.has(String(s.status)))
  if (active.length === 0) return null
  const sorted = [...active].sort((a, b) => {
    const aTime = new Date(a.lastActivity ?? a.createdAt).getTime()
    const bTime = new Date(b.lastActivity ?? b.createdAt).getTime()
    return bTime - aTime
  })
  return sorted[0] ?? null
}

export function chainProject(chain: ChainSummary): string | null {
  // Most recent session's project. Brand-new chains have no sessions and
  // therefore no project — caller must resolve via a picker.
  if (chain.sessions.length === 0) return null
  const sorted = [...chain.sessions].sort((a, b) => {
    const aTime = new Date(a.lastActivity ?? a.createdAt).getTime()
    const bTime = new Date(b.lastActivity ?? b.createdAt).getTime()
    return bTime - aTime
  })
  return sorted[0]?.project ?? null
}

async function abortSession(sessionId: string): Promise<void> {
  const resp = await fetch(`/api/sessions/${sessionId}/abort`, { method: 'POST' })
  if (!resp.ok) {
    throw new Error(`Abort failed: ${resp.status}`)
  }
}

export async function spawnChainSession(input: {
  project: string
  agent: string
  issueNumber: number
  model?: string
  prompt?: string
}): Promise<string> {
  const resp = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: input.project,
      // Server requires a non-empty prompt; use a kata-mode placeholder
      // so the runner starts immediately. The real mode prompt is the
      // agent's system prompt + kata mode config.
      prompt: input.prompt ?? `enter ${input.agent}`,
      model: input.model ?? 'sonnet',
      agent: input.agent,
      kataIssue: input.issueNumber,
    }),
  })
  if (!resp.ok) {
    throw new Error(`Spawn failed: ${resp.status}`)
  }
  const json = (await resp.json()) as { session_id?: string }
  if (!json.session_id) {
    throw new Error('Spawn returned no session_id')
  }
  return json.session_id
}

export async function advanceChain(
  chain: ChainSummary,
  nextMode: string,
): Promise<AdvanceChainResult> {
  const project = chainProject(chain)
  if (!project) {
    return { ok: false, error: 'No project for chain' }
  }
  try {
    // B11: code-touching modes must reserve the worktree before spawn.
    // Read-only modes (research, planning) skip the gate.
    if (CODE_TOUCHING_MODES.has(nextMode)) {
      const checkoutResp = await fetch(`/api/chains/${chain.issueNumber}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ worktree: project, modeAtCheckout: nextMode }),
      })
      if (checkoutResp.status === 409) {
        const body = (await checkoutResp.json().catch(() => null)) as {
          conflict?: WorktreeReservation
          message?: string
        } | null
        return {
          ok: false,
          error: body?.message ?? 'Worktree already held',
          conflict: body?.conflict,
        }
      }
      if (!checkoutResp.ok) {
        return { ok: false, error: `Checkout failed: ${checkoutResp.status}` }
      }
    }

    const active = latestActiveSession(chain)
    if (active) {
      await abortSession(active.id)
    }
    const sessionId = await spawnChainSession({
      project,
      agent: nextMode,
      issueNumber: chain.issueNumber,
    })
    return { ok: true, sessionId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Exported for Start-next button to decide its label. */
export function hasActiveSession(chain: ChainSummary): boolean {
  return latestActiveSession(chain) !== null
}
