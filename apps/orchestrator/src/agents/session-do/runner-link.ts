import { timingSafeEqual } from 'node:crypto'

import type { ExecuteCommand, GatewayCommand, PermissionMode, ResumeCommand } from '~/lib/types'
import { getSessionStatus } from '~/lib/vps-client'
import { syncIdentityNameToD1 } from './status'
import { RECOVERY_GRACE_MS, type SessionDOContext } from './types'
import { clearRecoveryGraceTimer, scheduleWatchdog } from './watchdog'

/**
 * Spec #101 Stage 4 + Stage 6: runner-link.
 *
 * Owns the DO-side runner control plane: trigger a gateway dial, send a
 * GatewayCommand over the live WS, recover after a dropped connection,
 * and read the cached / persisted gateway connection id.
 *
 * Stage 6 absorbed token / URL helpers from the now-deleted
 * `session-do-helpers.ts`: `constantTimeEquals`, `validateGatewayToken`,
 * `buildGatewayCallbackUrl`, `buildGatewayStartUrl`,
 * `getGatewayConnectionIdFromSql`.
 */

/** Minimal tagged-template SQL interface used by free helpers in this module. */
type SqlFn = <T>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[]

/**
 * Constant-time string compare. Returns false if lengths differ (avoids
 * the length-mismatch throw from Node's timingSafeEqual) and otherwise
 * defers to node:crypto's timingSafeEqual over utf-8 bytes.
 *
 * Note: this leaks the EXPECTED length — it does not hide it. Acceptable
 * for fixed-length secrets (UUIDs, hex hashes of known size) because the
 * attacker already knows that length. For variable-length secrets, pad
 * before comparing.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  try {
    return timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

/**
 * Validate a gateway token against stored token and TTL. Returns true if
 * the token is valid and not expired. The token is NOT consumed on use —
 * it remains valid until its TTL expires, allowing reconnects to reuse
 * the same callback URL.
 */
export function validateGatewayToken(sql: SqlFn, token: string | null): boolean {
  if (!token) return false
  try {
    const rows = [...sql<{ value: string }>`SELECT value FROM kv WHERE key = 'gateway_token'`]
    if (rows.length === 0 || rows[0].value !== token) return false

    const expiresRows = [
      ...sql<{ value: string }>`SELECT value FROM kv WHERE key = 'gateway_token_expires'`,
    ]
    if (expiresRows.length > 0 && Number(expiresRows[0].value) < Date.now()) {
      sql`DELETE FROM kv WHERE key IN ('gateway_token', 'gateway_token_expires')`
      return false
    }

    return true
  } catch {
    return false
  }
}

/**
 * D1-flat-string -> SDK discriminated-union converter for the user's
 * `thinking_mode` preference. Returns `undefined` for unknown values
 * so the caller skips the field rather than passing garbage to the SDK.
 *
 * The SDK's `thinking` shape carries optional `budgetTokens` and
 * `display`; user_preferences only stores the mode discriminator, so
 * the SDK's defaults apply for the inner fields.
 */
export function mapThinkingPref(mode: string | null | undefined): ExecuteCommand['thinking'] {
  switch (mode) {
    case 'adaptive':
      return { type: 'adaptive' }
    case 'enabled':
      return { type: 'enabled' }
    case 'disabled':
      return { type: 'disabled' }
    default:
      return undefined
  }
}

/**
 * D1-flat-string -> SDK literal converter for the user's `effort`
 * preference. Returns `undefined` for unknown values so the caller
 * skips the field rather than passing garbage to the SDK.
 */
export function mapEffortPref(value: string | null | undefined): ExecuteCommand['effort'] {
  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value
    default:
      return undefined
  }
}

/** Read the persisted gateway connection ID from SQLite kv table. */
export function getGatewayConnectionIdFromSql(sql: SqlFn): string | null {
  try {
    const rows = [...sql<{ value: string }>`SELECT value FROM kv WHERE key = 'gateway_conn_id'`]
    return rows.length > 0 ? rows[0].value : null
  } catch {
    return null
  }
}

/**
 * Build the callback URL that the gateway should dial back to.
 */
export function buildGatewayCallbackUrl(
  workerPublicUrl: string,
  doId: string,
  token: string,
): string {
  const wsScheme = workerPublicUrl.startsWith('https') ? 'wss' : 'ws'
  const wsBase = workerPublicUrl.replace(/^https?:/, `${wsScheme}:`)
  return `${wsBase}/agents/session-agent/${doId}?role=gateway&token=${token}`
}

/**
 * Build the gateway HTTP start URL from a gateway WebSocket URL.
 */
export function buildGatewayStartUrl(gatewayUrl: string): string {
  const httpBase = gatewayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  return `${httpBase}/sessions/start`
}

/**
 * Read the gateway connection ID, using in-memory cache when available.
 * Falls back to SQLite kv on cache miss (e.g. after a hibernation wake).
 */
export function getGatewayConnectionId(ctx: SessionDOContext): string | null {
  if (ctx.do.cachedGatewayConnId) return ctx.do.cachedGatewayConnId
  const id = getGatewayConnectionIdFromSql(ctx.do.sql.bind(ctx.do))
  ctx.do.cachedGatewayConnId = id
  return id
}

/**
 * Send a GatewayCommand to the live runner over the gateway-role WS.
 * No-ops with a console warning when no gateway connection is attached;
 * callers that require the command to land must check
 * `getGatewayConnectionId(ctx)` first.
 */
export function sendToGateway(ctx: SessionDOContext, cmd: GatewayCommand): void {
  const gwConnId = getGatewayConnectionId(ctx)
  if (!gwConnId) {
    console.error(`[SessionDO:${ctx.ctx.id}] Cannot send to gateway: no active connection`)
    return
  }
  for (const conn of ctx.getConnections()) {
    if (conn.id === gwConnId) {
      try {
        conn.send(JSON.stringify(cmd))
      } catch (err) {
        console.error(`[SessionDO:${ctx.ctx.id}] Failed to send to gateway:`, err)
      }
      return
    }
  }
  console.error(
    `[SessionDO:${ctx.ctx.id}] Gateway connection ${gwConnId} not found in active connections`,
  )
}

/**
 * GH#119 P2: pick an available runner identity via LRU, stamp
 * `runner_home` onto the command, bump `last_used_at`, and mirror the
 * identity name onto the `agent_sessions` D1 row.
 *
 * Fail-open: any D1 error returns the original `cmd` unchanged so the
 * gateway uses its own HOME (the pre-GH#119 default). The same applies
 * when the catalog is empty / every row is on cooldown.
 *
 * Extracted from `triggerGatewayDial` so the LRU / cooldown / fail-open
 * branches are unit-testable without a full DO harness.
 */
export async function selectAndStampIdentity<C extends ExecuteCommand | ResumeCommand>(
  ctx: SessionDOContext,
  cmd: C,
): Promise<C> {
  try {
    // `last_used_at IS NULL DESC` puts never-used identities first
    // (they're the most natural pick over an LRU sweep); after that
    // ASC orders the remainder by oldest-use-first.
    const row = await ctx.env.AUTH_DB.prepare(
      `SELECT id, name, home_path FROM runner_identities
         WHERE status = 'available'
           AND (cooldown_until IS NULL OR cooldown_until < datetime('now'))
         ORDER BY last_used_at IS NULL DESC, last_used_at ASC
         LIMIT 1`,
    ).first<{ id: string; name: string; home_path: string }>()

    if (!row) {
      ctx.logEvent('info', 'identity', 'no identity available — using gateway default')
      return cmd
    }

    const next = { ...cmd, runner_home: row.home_path }
    try {
      await ctx.env.AUTH_DB.prepare(
        `UPDATE runner_identities
             SET last_used_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?`,
      )
        .bind(row.id)
        .run()
    } catch (err) {
      ctx.logEvent('warn', 'identity', 'failed to update last_used_at', {
        identityId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    ctx.logEvent('info', 'identity', `selected ${row.name}`, {
      identityId: row.id,
      homePath: row.home_path,
    })
    // Mirror onto the D1 `agent_sessions` row + broadcast so the UI
    // sees which identity owns the session. Failure here is swallowed
    // inside the helper.
    await syncIdentityNameToD1(ctx, row.name, new Date().toISOString())
    return next
  } catch (err) {
    ctx.logEvent('warn', 'identity', 'identity selection failed — using gateway default', {
      error: err instanceof Error ? err.message : String(err),
    })
    return cmd
  }
}

/**
 * Trigger the gateway to dial back into this DO via outbound WS.
 *
 * Lifecycle (per B4b):
 *   1. Mint a fresh callback_token (UUID v4).
 *   2. If a previous token was active, close any live gateway-role WS with
 *      code 4410 ("token rotated") BEFORE persisting the new token — this
 *      prevents an old session-runner from continuing to stream into the DO
 *      concurrently with the newly-spawned runner.
 *   3. Persist the new token via setState (JSON blob — no migration).
 *   4. POST /sessions/start with {callback_url, callback_token, cmd}.
 *   5. On success, persist the gateway-assigned session_id.
 */
export async function triggerGatewayDial(
  ctx: SessionDOContext,
  cmd: GatewayCommand,
): Promise<void> {
  const gatewayUrl = ctx.env.CC_GATEWAY_URL
  const workerPublicUrl = ctx.env.WORKER_PUBLIC_URL
  if (!gatewayUrl || !workerPublicUrl) {
    console.error(`[SessionDO:${ctx.ctx.id}] CC_GATEWAY_URL or WORKER_PUBLIC_URL not configured`)
    ctx.do.updateState({ status: 'idle', error: 'Gateway URL or Worker URL not configured' })
    return
  }

  // GH#86: inject titler_enabled into execute/resume commands. Read from
  // D1 feature_flags (5-min cached). Fail-open (default true) so new
  // deploys work before the admin toggles anything.
  if (cmd.type === 'execute' || cmd.type === 'resume') {
    const titlerEnabled = await ctx.do.getFeatureFlagEnabled('haiku_titler', true)
    cmd = { ...cmd, titler_enabled: titlerEnabled }
  }

  // GH#119: inject session_store_enabled into execute/resume commands.
  // Default-OFF — the SessionStore mirror is opt-in until P3 (auto-failover)
  // ships. P3 flips the flag on globally for sessions that require failover
  // support; before then, runners stay on filesystem-only behavior.
  if (cmd.type === 'execute' || cmd.type === 'resume') {
    const sessionStoreEnabled = await ctx.do.getFeatureFlagEnabled('session_store', false)
    cmd = { ...cmd, session_store_enabled: sessionStoreEnabled }
  }

  // Inject user_preferences onto spawn / resume payloads. Reads from
  // D1 `user_preferences` for `ctx.state.userId` in a single query.
  // Fail-open per field: on D1 miss / unknown value the runner falls
  // back to its hardcoded default. `permission_mode` applies to both
  // execute and resume; the rest only on execute because the runner
  // only reads them on the execute branch (resume inherits from the
  // prior runner_session). Lifting them to resume is a follow-up.
  if (cmd.type === 'execute' || cmd.type === 'resume') {
    const userId = ctx.state.userId
    if (userId) {
      try {
        const row = await ctx.env.AUTH_DB.prepare(
          'SELECT permission_mode, thinking_mode, effort, max_budget FROM user_preferences WHERE user_id = ?',
        )
          .bind(userId)
          .first<{
            permission_mode: string | null
            thinking_mode: string | null
            effort: string | null
            max_budget: number | null
          }>()

        if (row?.permission_mode) {
          cmd = { ...cmd, permission_mode: row.permission_mode as PermissionMode }
        }

        // The remaining three only apply on execute — resume ignores
        // them today (see comment above). Skip the wire bytes on resume.
        if (cmd.type === 'execute') {
          const thinking = mapThinkingPref(row?.thinking_mode)
          if (thinking) cmd = { ...cmd, thinking }

          const effort = mapEffortPref(row?.effort)
          if (effort) cmd = { ...cmd, effort }

          if (typeof row?.max_budget === 'number' && row.max_budget > 0) {
            cmd = { ...cmd, max_budget_usd: row.max_budget }
          }
        }
      } catch (err) {
        console.error(`[SessionDO:${ctx.ctx.id}] Failed to read user_preferences from D1:`, err)
        // Proceed without — runner falls back to its hardcoded defaults.
      }
    }
  }

  // GH#107: inject codex_models catalog onto codex spawn payloads. Reads
  // from D1 `codex_models WHERE enabled = 1`. Fail-open: on D1 read
  // failure the runner falls back to the adapter's hardcoded defaults.
  if (cmd.type === 'execute' || cmd.type === 'resume') {
    if (cmd.agent === 'codex') {
      try {
        const result = await ctx.env.AUTH_DB.prepare(
          'SELECT name, context_window FROM codex_models WHERE enabled = 1 ORDER BY name',
        ).all<{ name: string; context_window: number }>()
        cmd = { ...cmd, codex_models: result.results ?? [] }
      } catch (err) {
        console.error(`[SessionDO:${ctx.ctx.id}] Failed to read codex_models from D1:`, err)
        // Proceed without — adapter falls back to hardcoded defaults.
      }
    }
  }

  // GH#119 P2: select a runner identity via LRU and stamp `runner_home`
  // onto the spawn command. Extracted to a free helper so unit tests can
  // exercise the LRU / cooldown / fail-open / zero-identities branches
  // without spinning up a DO harness — see `identity-selection.test.ts`.
  if (cmd.type === 'execute' || cmd.type === 'resume') {
    cmd = await selectAndStampIdentity(ctx, cmd)
  }

  const callback_token = crypto.randomUUID()

  // Ordering invariant: close the old gateway WS FIRST, then rotate the
  // token via updateState, then POST. If onClose races us during this
  // window, maybeRecoverAfterGatewayDrop probes gateway status — it does
  // not read active_callback_token directly, so a stale token in state
  // cannot cause a wrong branch. The close-first-then-rotate order
  // matters anyway so a reconnect from the old runner can't slip in
  // between the token swap and the POST.
  // Rotate: close any existing gateway-role WS on this DO with 4410 before
  // storing the new token so old+new runners don't both stream to the DO.
  if (ctx.state.active_callback_token) {
    const oldConnId = getGatewayConnectionId(ctx)
    if (oldConnId) {
      for (const conn of ctx.getConnections()) {
        if (conn.id === oldConnId) {
          try {
            conn.close(4410, 'token rotated')
          } catch (err) {
            console.error(`[SessionDO:${ctx.ctx.id}] Failed to close old gateway WS:`, err)
          }
          break
        }
      }
      // Clear the connection-id cache; onClose will also clear but the new
      // runner should not find a stale id in the meantime.
      ctx.do.cachedGatewayConnId = null
      try {
        ctx.sql.exec(`DELETE FROM kv WHERE key = 'gateway_conn_id'`)
      } catch {
        /* ignore */
      }
    }
  }

  ctx.do.updateState({ active_callback_token: callback_token })

  // Build callback URL: wss://worker-url/agents/session-agent/<do-id>?role=gateway&token=<token>
  const callbackUrl = buildGatewayCallbackUrl(
    workerPublicUrl,
    ctx.ctx.id.toString(),
    callback_token,
  )

  // POST to gateway to trigger dial-back
  const startUrl = buildGatewayStartUrl(gatewayUrl)

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ctx.env.CC_GATEWAY_SECRET) {
      headers.Authorization = `Bearer ${ctx.env.CC_GATEWAY_SECRET}`
    }

    const resp = await fetch(startUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ callback_url: callbackUrl, callback_token, cmd }),
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'unknown error')
      console.error(`[SessionDO:${ctx.ctx.id}] Gateway start failed: ${resp.status} ${errText}`)
      // Spec #80 B7 — runner never attached; terminate any stamped
      // awaiting part immediately rather than letting it hang (no
      // watchdog alarm was scheduled on this failure path).
      await ctx.do.failAwaitingTurn(`Gateway start failed: ${resp.status}`)
      return
    }

    // Persist the gateway-assigned session_id so subsequent /sessions/:id/status
    // calls use the gateway's canonical id (distinct from the DO id).
    try {
      const parsed = (await resp.json()) as { ok?: boolean; session_id?: string }
      if (parsed?.session_id) {
        ctx.do.updateState({ session_id: parsed.session_id })
      }
    } catch (err) {
      console.error(`[SessionDO:${ctx.ctx.id}] Failed to parse gateway /sessions/start body:`, err)
    }

    ctx.do.lastGatewayActivity = Date.now()
    scheduleWatchdog(ctx)
    console.log(`[SessionDO:${ctx.ctx.id}] triggerGatewayDial: POST to gateway succeeded`)
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Gateway start POST failed:`, err)
    // Spec #80 B7 — runner never attached; terminate any stamped
    // awaiting part immediately rather than letting it hang (no
    // watchdog alarm was scheduled on this failure path).
    const msg = err instanceof Error ? err.message : String(err)
    await ctx.do.failAwaitingTurn(`Gateway start failed: ${msg}`)
  }
}

/**
 * Implements B7 (status-aware recovery). Called from `onClose` for the
 * gateway-role connection. Probes `GET /sessions/:id/status` with a 5s
 * timeout and decides whether to finalize the DO or wait for a re-dial.
 *
 * Defensive fallback: on any unreachable / non-200 / non-404 result, run
 * `recoverFromDroppedConnection` as the DO cannot trust the gateway's
 * liveness signal.
 */
export async function maybeRecoverAfterGatewayDrop(ctx: SessionDOContext): Promise<void> {
  const gatewayUrl = ctx.env.CC_GATEWAY_URL
  const sessionId = ctx.state.session_id
  if (!gatewayUrl || !sessionId) {
    await ctx.do.recoverFromDroppedConnection()
    return
  }

  const result = await getSessionStatus(gatewayUrl, ctx.env.CC_GATEWAY_SECRET, sessionId, 5_000)

  if (result.kind === 'state') {
    const runnerState = result.body.state
    // Only 'running' runners can possibly reconnect via DialBackClient
    // backoff. Terminal states (crashed/failed/aborted/completed) mean the
    // runner process is gone — recover immediately instead of burning a
    // 15s grace window waiting for a reconnect that will never happen.
    if (runnerState !== 'running') {
      console.log(
        `[SessionDO:${ctx.ctx.id}] WS dropped, gateway reports terminal state=${runnerState} — running recovery immediately`,
      )
      await ctx.do.recoverFromDroppedConnection()
      return
    }

    // GH#57: runner still alive on the VPS — its DialBackClient will retry
    // (1s/3s/9s backoff). Grace the close to avoid clearing the callback
    // token mid-reconnect (which would 4401 the runner and kill it).
    //
    // Two-tier grace: the setTimeout is the fast path when the DO stays
    // live for the full window; the persisted kv deadline is the
    // hibernation-safe backstop checked in alarm(). Without the durable
    // row, a DO eviction during the 15s window drops the timer and
    // recovery never runs — status stays 'running' forever and the next
    // sendMessage trips the gate at "Cannot send message: status is
    // 'running'" with no attached runner.
    const deadline = Date.now() + RECOVERY_GRACE_MS
    console.log(
      `[SessionDO:${ctx.ctx.id}] WS dropped, gateway reports state=running — scheduling recovery grace (${RECOVERY_GRACE_MS}ms, deadline=${deadline})`,
    )
    clearRecoveryGraceTimer(ctx)
    try {
      ctx.sql.exec(
        `INSERT OR REPLACE INTO kv (key, value) VALUES ('recovery_grace_until', ?)`,
        String(deadline),
      )
    } catch (err) {
      console.warn(`[SessionDO:${ctx.ctx.id}] Failed to persist recovery_grace_until:`, err)
    }
    // Pull the alarm in to the grace deadline so a hibernation-wake post-
    // deadline runs recovery on the first alarm tick rather than waiting
    // for the next 30s watchdog cycle.
    try {
      ctx.ctx.storage.setAlarm(deadline)
    } catch (err) {
      console.warn(`[SessionDO:${ctx.ctx.id}] Failed to set recovery-grace alarm:`, err)
    }
    ctx.do.recoveryGraceTimer = setTimeout(async () => {
      ctx.do.recoveryGraceTimer = null
      if (getGatewayConnectionId(ctx)) {
        console.log(
          `[SessionDO:${ctx.ctx.id}] Recovery grace expired but runner reconnected — skipping recovery`,
        )
        clearRecoveryGraceTimer(ctx)
        return
      }
      console.log(
        `[SessionDO:${ctx.ctx.id}] Recovery grace expired, no reconnect — running recovery`,
      )
      await ctx.do.recoverFromDroppedConnection()
    }, RECOVERY_GRACE_MS)
    return
  }

  if (result.kind === 'not_found') {
    console.log(`[SessionDO:${ctx.ctx.id}] WS dropped, gateway 404 — running recovery (orphan)`)
    await ctx.do.recoverFromDroppedConnection()
    return
  }

  console.log(
    `[SessionDO:${ctx.ctx.id}] WS dropped, status unreachable (${result.reason}) — running recovery (defensive)`,
  )
  await ctx.do.recoverFromDroppedConnection()
}
