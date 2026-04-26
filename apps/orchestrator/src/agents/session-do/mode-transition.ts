import { asc, eq } from 'drizzle-orm'
import { agentSessions } from '~/db/schema'
import { CORE_RUNGS, tryAutoAdvance } from '~/lib/auto-advance'
import { isChainSessionCompleted } from '~/lib/chains'
import type { KataSessionState } from '~/lib/types'
import { rebindTabsForSession } from '~/lib/update-tab-session'
import { broadcastGatewayEvent as broadcastGatewayEventImpl } from './broadcast'
import { triggerGatewayDial as triggerGatewayDialImpl } from './runner-link'
import type { SessionDOContext } from './types'

/**
 * Spec #101 Stage 6: extracted bodies of `SessionDO.maybeAutoAdvanceChain()`,
 * `SessionDO.handleModeTransition(...)`, and the private
 * `buildModePreamble(...)` helper.
 *
 * All three live in the same module because they share chain / kata
 * domain wiring (D1 + auto-advance gates + artifact-pointer preamble).
 */

/**
 * Chain auto-advance — spec 16-chain-ux-p1-5 B6 / B7 / B9.
 * Runs on the `stopped` terminal transition for sessions stamped with a
 * `kataIssue` + core `kataMode`. Reads the user's chain auto-advance
 * preference from D1, runs the gate check, and if green spawns the
 * successor session + rebinds the user's open tab(s). Emits
 * `chain_advance` / `chain_stalled` events so the client ChainStatusItem
 * widget can invalidate chain data and surface a toast / warn indicator.
 */
export async function maybeAutoAdvanceChainImpl(ctx: SessionDOContext): Promise<void> {
  const userId = ctx.state.userId
  const sessionId = ctx.state.session_id
  const project = ctx.state.project
  const kataMode = ctx.state.lastKataMode
  if (!userId || !sessionId || !project || !kataMode) return
  if (!CORE_RUNGS.has(kataMode)) return

  // kataIssue isn't on SessionMeta — source it from the D1 row.
  // A single PK lookup; cheap.
  let kataIssue: number | null = null
  try {
    const rows = await ctx.do.d1
      .select({ kataIssue: agentSessions.kataIssue })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1)
    kataIssue = rows[0]?.kataIssue ?? null
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] auto-advance: failed to read kataIssue`, err)
    return
  }
  if (kataIssue == null) return

  try {
    const result = await tryAutoAdvance(
      ctx.env,
      {
        sessionId,
        userId,
        kataIssue,
        kataMode,
        project,
        // GH#73: the authoritative "rung finished" signal. Persisted from
        // `kata_state` events whenever the runner observes run-end.json —
        // kata's Stop hook writes it on successful can-exit only, so this
        // is the single source of truth for auto-advance.
        runEnded: ctx.state.lastRunEnded === true,
      },
      ctx.ctx,
    )
    if (result.action === 'advanced') {
      try {
        await rebindTabsForSession(ctx.env, userId, sessionId, result.newSessionId, ctx.ctx)
      } catch (err) {
        console.error(`[SessionDO:${ctx.ctx.id}] rebindTabsForSession failed:`, err)
      }
      broadcastGatewayEventImpl(ctx, {
        type: 'chain_advance',
        newSessionId: result.newSessionId,
        nextMode: result.nextMode,
        issueNumber: kataIssue,
      })
    } else if (result.action === 'stalled') {
      broadcastGatewayEventImpl(ctx, {
        type: 'chain_stalled',
        reason: result.reason,
        issueNumber: kataIssue,
      })
    } else if (result.action === 'error') {
      console.error(`[SessionDO:${ctx.ctx.id}] auto-advance error: ${result.error}`)
      broadcastGatewayEventImpl(ctx, {
        type: 'chain_stalled',
        reason: `Auto-advance failed: ${result.error}`,
        issueNumber: kataIssue,
      })
    }
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] auto-advance uncaught error:`, err)
  }
}

/**
 * Chain UX P4 — mode-enter session reset.
 *
 * Triggered when a chain-linked session observes a `kata_state` event
 * with a different `currentMode` than previously seen and `continueSdk`
 * is not set. Flushes the outbound channel, kicks the active runner WS
 * with close code 4411 (mode_transition), waits up to 5s for the runner
 * to exit, then spawns a fresh runner in the new mode with an artifact-
 * pointer preamble.
 */
export async function handleModeTransitionImpl(
  ctx: SessionDOContext,
  kataState: KataSessionState,
  fromMode: string | null,
): Promise<void> {
  const sessionId = ctx.do.name
  const toMode = kataState.currentMode ?? ''
  const issueNumber = kataState.issueNumber ?? 0

  console.log(
    `[SessionDO:${ctx.ctx.id}] mode transition ${fromMode ?? '(none)'}→${toMode} issue=#${issueNumber}`,
  )

  // 1. Announce the transition to browsers so the chain timeline UI picks it up.
  // Synthetic DO-fabricated event for browser UI — not on the GatewayEvent
  // wire union (which only covers runner→DO events).
  broadcastGatewayEventImpl(ctx, {
    type: 'mode_transition',
    session_id: sessionId,
    from: fromMode,
    to: toMode,
    issueNumber,
    at: new Date().toISOString(),
  } as any)

  // 2. Flush window — BufferedChannel has no in-flight-send introspection,
  //    so the best we can do is a short pause to let the runner's final
  //    pre-transition events land before we slam the WS shut.
  await new Promise((r) => setTimeout(r, 2000))

  // 3. Close the runner WS with 4411 (mode_transition). Mirrors the 4410
  //    rotation path in triggerGatewayDial.
  const gwConnId = ctx.do.getGatewayConnectionId()
  if (gwConnId) {
    for (const conn of ctx.getConnections()) {
      if (conn.id === gwConnId) {
        try {
          conn.close(4411, 'mode_transition')
        } catch (err) {
          console.error(
            `[SessionDO:${ctx.ctx.id}] Failed to close runner WS on mode transition:`,
            err,
          )
        }
        break
      }
    }
    ctx.do.cachedGatewayConnId = null
    try {
      ctx.do.sql`DELETE FROM kv WHERE key = 'gateway_conn_id'`
    } catch {
      /* ignore */
    }
    // Explicitly clear the callback token so the poll below proceeds on
    // the happy path. onClose only clears this when status is
    // running/waiting_gate, which doesn't cover every mode-transition
    // case — without this clear the poll below always falls through to
    // the 5s timeout.
    ctx.do.updateState({ active_callback_token: undefined })
  }

  // 4. Wait up to 5s for the runner to exit — signalled by the DO's
  //    onClose handler clearing `active_callback_token` (or the token
  //    rotating to a new value). Poll state.active_callback_token at
  //    100ms granularity.
  const startTok = ctx.state.active_callback_token
  const exited = await new Promise<boolean>((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      clearInterval(interval)
      clearTimeout(timeout)
      resolve(value)
    }
    const check = () => {
      const tok = ctx.state.active_callback_token
      if (!tok || tok !== startTok) done(true)
    }
    const interval = setInterval(check, 100)
    const timeout = setTimeout(() => done(false), 5000)
    check()
  })

  if (!exited) {
    console.warn(
      `[SessionDO:${ctx.ctx.id}] mode transition: runner did not exit within 5s — proceeding (token rotation in triggerGatewayDial will evict lingering runner via 4410)`,
    )
    // Synthetic DO-fabricated event — not on the wire union.
    broadcastGatewayEventImpl(ctx, {
      type: 'mode_transition_timeout',
      session_id: sessionId,
      issueNumber,
      at: new Date().toISOString(),
      note: 'runner did not exit within 5s; proceeding with fresh spawn',
    } as any)
  }

  // 5. Build preamble (degrade gracefully on failure).
  const preamble = await buildModePreambleImpl(ctx, kataState)

  // 6. Spawn fresh runner in the new mode. triggerGatewayDial handles any
  //    lingering runner via 4410 rotation.
  // NOTE: GH#107 P1 narrows `ExecuteCommand.agent` to `AgentName`. Prior
  // to this, `agent: toMode` was passed here with a kata mode value
  // (`'planning'`, `'implementation'`, etc.) — that was always wrong:
  // ClaudeRunner ignored `cmd.agent` entirely, so the field was a
  // dead-letter on the wire. Dropped here so the runner-side adapter
  // registry (which now treats `cmd.agent` authoritatively) defaults
  // to ClaudeAdapter for chain mode transitions, preserving the
  // pre-narrowing runtime behaviour.
  await triggerGatewayDialImpl(ctx, {
    type: 'execute',
    project: ctx.state.project,
    prompt: preamble,
    model: ctx.state.model ?? 'sonnet',
  })
}

/**
 * Build the artifact-pointer preamble prepended to the fresh runner's
 * first prompt on a chain mode transition. Queries D1 for prior sessions
 * linked to the same issueNumber and emits a one-line pointer per
 * completed mode. On any failure, falls back to the degraded template
 * from the spec and emits `mode_transition_preamble_degraded` so the UI
 * can surface it.
 */
export async function buildModePreambleImpl(
  ctx: SessionDOContext,
  ks: KataSessionState,
): Promise<string> {
  const issueNumber = ks.issueNumber ?? 0
  const mode = ks.currentMode ?? 'unknown'
  const phase = ks.currentPhase ?? 'p0'
  const sessionId = ctx.do.name

  // Issue title is not a first-class field on the DO — leave as
  // 'untitled' until chain metadata plumbing lands (downstream P5 work).
  const issueTitle = 'untitled'

  const degraded = () =>
    `You are entering ${mode} mode for issue #${issueNumber}. Prior-artifact listing is unavailable — use the kata CLI (\`kata status\`) to inspect chain state. Your kata state is already linked: workflowId=GH#${issueNumber}, mode=${mode}, phase=${phase}.`

  try {
    const rows = await ctx.do.d1
      .select({
        id: agentSessions.id,
        status: agentSessions.status,
        kataMode: agentSessions.kataMode,
        createdAt: agentSessions.createdAt,
        lastActivity: agentSessions.lastActivity,
      })
      .from(agentSessions)
      .where(eq(agentSessions.kataIssue, issueNumber))
      .orderBy(asc(agentSessions.createdAt))

    const artifactLines: string[] = []
    for (const row of rows) {
      // agent_sessions.status never holds 'completed' in this codebase;
      // finished rungs park as 'idle' with a non-null lastActivity. Use
      // the shared predicate so this stays aligned with the client-side
      // chain-progression gates (see lib/chains.ts).
      if (!isChainSessionCompleted({ status: row.status, lastActivity: row.lastActivity })) continue
      const rowMode = row.kataMode ?? 'unknown'
      const idTail = row.id.slice(-8)
      artifactLines.push(`- ${rowMode}: session ${idTail}`)
    }

    const artifacts = artifactLines.length > 0 ? artifactLines.join('\n') : '- (none yet)'

    return `You are entering ${mode} mode for issue #${issueNumber} ("${issueTitle}").

Prior artifacts in this chain:
${artifacts}

Read the relevant artifacts before acting. Your kata state is already linked: workflowId=GH#${issueNumber}, mode=${mode}, phase=${phase}.`
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[SessionDO:${ctx.ctx.id}] buildModePreamble failed:`, err)
    // Synthetic DO-fabricated event — not on the wire union.
    broadcastGatewayEventImpl(ctx, {
      type: 'mode_transition_preamble_degraded',
      session_id: sessionId,
      issueNumber,
      at: new Date().toISOString(),
      reason,
    } as any)
    return degraded()
  }
}
