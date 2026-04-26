import { timingSafeEqual } from 'node:crypto'

import type { GatewayCommand } from '~/lib/types'
import { getSessionStatus } from '~/lib/vps-client'
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
