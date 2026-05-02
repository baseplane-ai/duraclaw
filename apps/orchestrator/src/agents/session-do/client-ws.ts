import type {
  SyncedCollectionOp,
  SessionMessage as WireSessionMessage,
} from '@duraclaw/shared-types'
import type { Connection, ConnectionContext } from 'agents'
import { chunkOps } from '~/lib/chunk-frame'
import { parseEvent } from '~/lib/vps-client'
import { constantTimeEquals } from './runner-link'
import type { SessionDOContext } from './types'
import { clearRecoveryGraceTimer as clearRecoveryGraceTimerImpl } from './watchdog'

/**
 * Spec #101 Stage 6: client-side WS lifecycle extracted from SessionDO.
 *
 * Holds the gateway-vs-browser routing in `onConnect` / `onMessage` /
 * `onClose`, the cursor-aware replay used by `subscribe:messages`, and the
 * shared `logError` helper. Each function takes the `SessionDOContext` and
 * returns a value (or `void`) that the thin DO method shim re-throws.
 *
 * Pure delegation — no behavior change. Auth, observability, and recovery
 * scheduling are byte-for-byte the original SessionDO logic.
 */

/**
 * Unified error logger with full stack trace. Hibernated-DO wakes wrap
 * handler invocations such that unhandled throws surface only as an
 * `Unknown Event - Exception Thrown` tag in wrangler tail — the stack
 * never reaches logs. Explicitly logging here rescues that signal.
 */
export function logError(
  ctx: SessionDOContext,
  site: string,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  const prefix = `[SessionDO:${ctx.ctx.id}] ERROR@${site}`
  const extraStr = extra
    ? ' ' +
      Object.entries(extra)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
    : ''
  if (err instanceof Error) {
    console.error(`${prefix}${extraStr} ${err.name}: ${err.message}`, err.stack ?? err)
  } else {
    console.error(`${prefix}${extraStr}`, err)
  }
}

/**
 * Browser-connection state shape (GH#152 P1 B2). Stored via
 * `connection.setState` after the WS upgrade attaches `x-user-id` /
 * `x-user-email` headers. The broadcaster + comment/chat write paths
 * read this for sender attribution.
 */
export interface SessionClientConnectionState {
  userId: string | null
  userEmail: string | null
}

/**
 * Inner onConnect — gateway-token validation + persistence vs browser fall-
 * through. Wrapped by the public `onConnect` shim which adds the
 * enter/exit observability logs.
 */
function onConnectInner(
  ctx: SessionDOContext,
  connection: Connection,
  connCtx: ConnectionContext,
): void {
  const url = new URL(connCtx.request.url)
  const role = url.searchParams.get('role')

  if (role === 'gateway') {
    // Gateway connection: validate per-dial callback_token minted in
    // triggerGatewayDial. Timing-safe compare; leave token in state so
    // subsequent reconnects by the same session-runner succeed.
    const token = url.searchParams.get('token')
    const active = ctx.state.active_callback_token
    if (!token || !active || !constantTimeEquals(token, active)) {
      connection.close(4401, 'invalid callback token')
      return
    }

    // Persist gateway connection ID in SQLite (survives hibernation). Do NOT
    // use connection.setState — it conflicts with Agent SDK internals.
    ctx.sql.exec(
      `INSERT OR REPLACE INTO kv (key, value) VALUES ('gateway_conn_id', ?)`,
      connection.id,
    )
    ctx.do.cachedGatewayConnId = connection.id
    ctx.do.lastGatewayActivity = Date.now()

    // GH#57: runner reconnected after a transient WS flap — cancel the
    // pending recovery grace so we don't clear the callback token. The grace
    // lives as both an in-memory setTimeout (fast path) and a durable kv row
    // consulted by alarm() after hibernation; clear both.
    clearRecoveryGraceTimerImpl(ctx)

    console.log(`[SessionDO:${ctx.ctx.id}] Gateway connected: conn=${connection.id}`)
    return // No replay, no protocol messages
  }

  // Browser connection: stash the authed userId / userEmail on the
  // connection state so the broadcaster + comment/chat write paths can
  // attribute writes back to the calling user (GH#152 P1 B2). The
  // server.ts WS upgrade handler set `x-user-id` / `x-user-email` from
  // the Better Auth session before forwarding to the DO; if the headers
  // are missing (e.g. discovery-side path) we still record nulls so the
  // shape is uniform downstream.
  const userId = connCtx.request.headers.get('x-user-id')
  const userEmail = connCtx.request.headers.get('x-user-email')
  const clientState: SessionClientConnectionState = {
    userId: userId && userId.length > 0 ? userId : null,
    userEmail: userEmail && userEmail.length > 0 ? userEmail : null,
  }
  try {
    connection.setState(clientState)
  } catch (err) {
    // setState can be sensitive in the Agents SDK wrapper (see the
    // gateway path's note above). Log and swallow — falling back to a
    // null userId on the connection means downstream writers won't
    // populate sender_id, but the WS itself stays alive.
    logError(ctx, 'onConnect.setState', err, { connId: connection.id })
  }
}

export function handleOnConnect(
  ctx: SessionDOContext,
  connection: Connection,
  connCtx: ConnectionContext,
): void {
  // GH#49 + GH#61 observability: log socket-set size + same-id collision
  // count at the moment we enter onConnect. The `[SessionDO][conn] enter`
  // log is the critical diagnostic anchor — if a 1006 close appears in
  // `wrangler tail` WITHOUT a preceding `enter` for the same connId, the
  // throw happened inside the SDK wrapper (before our code runs).
  const t0 = Date.now()
  let totalSockets = -1
  let sameIdSockets = -1
  try {
    totalSockets = ctx.ctx.getWebSockets().length
    sameIdSockets = ctx.ctx.getWebSockets(connection.id).length
  } catch {
    // getWebSockets can't realistically throw, but don't let observability
    // crash the real handler.
  }
  const role = new URL(connCtx.request.url).searchParams.get('role') ?? 'browser'
  console.log(
    `[SessionDO][conn] enter doId=${ctx.ctx.id} connId=${connection.id} role=${role} totalSockets=${totalSockets} sameIdSockets=${sameIdSockets} status=${ctx.state.status}`,
  )
  try {
    onConnectInner(ctx, connection, connCtx)
    console.log(
      `[SessionDO][conn] exit doId=${ctx.ctx.id} connId=${connection.id} role=${role} ms=${Date.now() - t0}`,
    )
  } catch (err) {
    logError(ctx, 'onConnect', err, {
      connId: connection.id,
      role,
      totalSockets,
      sameIdSockets,
      ms: Date.now() - t0,
      status: ctx.state.status,
    })
    throw err
  }
}

/**
 * Browser-side onMessage routing — peels off `subscribe:messages` for
 * cursor-aware replay before falling through to the Agent base class's
 * @callable RPC dispatcher. Gateway frames are routed to the
 * gateway-event handler.
 *
 * Returns `'gateway'` if the frame was handled as a gateway event, or
 * `'replay'` if it was a `subscribe:messages` cursor request, or
 * `'rpc'` to signal the caller should delegate to `super.onMessage`.
 */
export function handleOnMessage(
  ctx: SessionDOContext,
  connection: Connection,
  data: string | ArrayBuffer,
): 'gateway' | 'replay' | 'rpc' {
  const gwConnId = ctx.do.getGatewayConnectionId()
  if (gwConnId && connection.id === gwConnId) {
    // Gateway message: parse and route to handleGatewayEvent
    ctx.do.lastGatewayActivity = Date.now()
    try {
      const raw = typeof data === 'string' ? data : new TextDecoder().decode(data)
      const event = parseEvent(raw)
      ctx.do.handleGatewayEvent(event)
    } catch (err) {
      logError(ctx, 'onMessage.handleGatewayEvent', err)
    }
    return 'gateway'
  }

  // GH#57: intercept cursor-aware sync subscribe BEFORE the @callable
  // dispatcher. Cold clients send `sinceCursor: null` and get everything,
  // warm clients send `(modifiedAt, id)` and get only what they're missing.
  //
  // v13 cursor unification: the canonical key is `modifiedAt`. A legacy
  // client may still send `{createdAt, id}` — we treat createdAt as the
  // modifiedAt floor (strictly conservative — over-replays rather than
  // under-replays).
  if (typeof data === 'string' && data.startsWith('{"type":"subscribe:messages"')) {
    try {
      const parsed = JSON.parse(data) as {
        type: 'subscribe:messages'
        sinceCursor?: { modifiedAt?: string; createdAt?: string; id: string } | null
      }
      const raw = parsed.sinceCursor ?? null
      const cursor =
        raw && (raw.modifiedAt || raw.createdAt)
          ? { modifiedAt: (raw.modifiedAt ?? raw.createdAt) as string, id: raw.id }
          : null
      void replayMessagesFromCursor(ctx, connection, cursor)
    } catch (err) {
      logError(ctx, 'onMessage.subscribe:messages', err, { connId: connection.id })
    }
    return 'replay'
  }

  return 'rpc'
}

/**
 * Gateway-WS close handler — clears the persisted `gateway_conn_id` and
 * kicks the status-aware recovery flow if the runner was supposed to be
 * attached. Browser closes fall through to the observability log.
 */
export function handleOnClose(
  ctx: SessionDOContext,
  connection: Connection,
  code: number,
  reason: string,
): void {
  const gwConnId = ctx.do.getGatewayConnectionId()
  if (gwConnId && connection.id === gwConnId) {
    console.log(`[SessionDO:${ctx.ctx.id}] Gateway WS closed: code=${code} reason=${reason}`)
    // Clear the persisted gateway connection ID
    ctx.do.cachedGatewayConnId = null
    try {
      ctx.sql.exec(`DELETE FROM kv WHERE key = 'gateway_conn_id'`)
    } catch (err) {
      logError(ctx, 'onClose.deleteKv', err)
    }

    // If session was active or a runner is expected (idle between turns
    // with active_callback_token), the connection dropped unexpectedly.
    // Ask the gateway for the runner's live state before running the
    // local recovery path — if the runner is still alive, its
    // DialBackClient will reconnect and we should wait rather than
    // finalizing the DO prematurely.
    const shouldRecover =
      ctx.state.status === 'running' ||
      ctx.state.status === 'waiting_gate' ||
      !!ctx.state.active_callback_token
    if (shouldRecover) {
      ctx.do.maybeRecoverAfterGatewayDrop().catch((err) => {
        logError(ctx, 'maybeRecoverAfterGatewayDrop', err)
      })
    }
    return
  }

  // GH#49 + GH#61 observability: pair with the `[SessionDO][conn]
  // enter` log so we can see per-connId open→close cycles in
  // `wrangler tail`. `remaining` is the post-close count from
  // ctx.getWebSockets — a non-zero value with the same id on a
  // reconnect-storm means zombie sockets are piling up in the
  // hibernation set.
  let remaining = -1
  try {
    remaining = ctx.ctx.getWebSockets(connection.id).length
  } catch {
    // no-op
  }
  if (code === 1006) {
    // GH#61: 1006 = abnormal closure — the server-side handler threw
    // without a clean close frame. This is the diagnostic anchor for
    // the "1ms WS flap" pathology.
    console.error(
      `[SessionDO][conn] 1006-diag doId=${ctx.ctx.id} connId=${connection.id} reason=${JSON.stringify(reason)} sameIdRemaining=${remaining} status=${ctx.state.status} hasGateway=${!!ctx.do.getGatewayConnectionId()} lastGatewayActivity=${ctx.do.lastGatewayActivity} sessionId=${ctx.state.session_id ?? 'none'}`,
    )
  } else {
    console.log(
      `[SessionDO][conn] close doId=${ctx.ctx.id} connId=${connection.id} code=${code} reason=${JSON.stringify(reason)} sameIdRemaining=${remaining}`,
    )
  }
}

/**
 * Cursor-aware delta replay — the contract for `subscribe:messages`. Pages
 * the indexed `(modified_at, id)` keyset 500 rows at a time, broadcasts
 * targeted `messages:*` frames to just `connection.id`, and exits with a
 * single diagnostic line covering total rows + first/last modifiedAt seen.
 *
 * No `getHistory()` call anywhere — each page is an index seek, so the
 * #57 storage-timeout hazard stays closed even for very long sessions.
 */
export async function replayMessagesFromCursor(
  ctx: SessionDOContext,
  connection: Connection,
  sinceCursor: { modifiedAt: string; id: string } | null,
): Promise<void> {
  // v13 unification: cursor keyset is `(modified_at, id)` — the single
  // monotonic "last touch" timestamp stamped by safeAppendMessage
  // (= created_at) and safeUpdateMessage (= now()). The previous
  // created_at cursor with a bolted-on `OR modified_at > cursor.createdAt`
  // clause re-emitted every historically-modified row on every warm
  // reconnect because the cursor never advanced past `modified_at`.
  let cursor = sinceCursor ?? { modifiedAt: '1970-01-01T00:00:00.000Z', id: '' }
  // Diagnostic (GH#78 addendum B): track replay totals so we can tell on
  // an idle-session reconnect whether the cursor was stale.
  let totalRows = 0
  let firstModifiedAt: string | null = null
  let lastModifiedAt: string | null = null
  try {
    while (true) {
      const rows = [
        ...ctx.sql.exec<{
          id: string
          created_at: string
          modified_at: string | null
          content: string
        }>(
          `SELECT id, created_at, modified_at, content FROM assistant_messages
           WHERE session_id = ''
             AND modified_at IS NOT NULL
             AND (
               (modified_at > ?)
               OR (modified_at = ? AND id > ?)
             )
           ORDER BY modified_at ASC, id ASC
           LIMIT 500`,
          cursor.modifiedAt,
          cursor.modifiedAt,
          cursor.id,
        ),
      ]
      if (rows.length === 0) return
      if (firstModifiedAt === null) {
        firstModifiedAt = rows[0].modified_at ?? rows[0].created_at
      }
      lastModifiedAt = rows[rows.length - 1].modified_at ?? rows[rows.length - 1].created_at
      totalRows += rows.length
      const msgs: WireSessionMessage[] = []
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.content) as WireSessionMessage
          // Stamp wire modifiedAt from the SQL column so the client's
          // tail cursor advances exactly to the server-authoritative
          // timestamp — no drift, no re-replay on the next reconnect.
          msgs.push({
            ...parsed,
            modifiedAt: row.modified_at ?? row.created_at,
          })
        } catch {
          // Unparseable row — skip; defensive, SDK writes valid JSON.
        }
      }
      if (msgs.length > 0) {
        const ops: SyncedCollectionOp<WireSessionMessage>[] = msgs.map((value) => ({
          type: 'insert' as const,
          value,
        }))
        for (const chunk of chunkOps(ops)) {
          ctx.do.broadcastMessages({ ops: chunk }, { targetClientId: connection.id })
        }
      }
      if (rows.length < 500) return
      const last = rows[rows.length - 1]
      cursor = { modifiedAt: last.modified_at ?? last.created_at, id: last.id }
    }
  } catch (err) {
    logError(ctx, 'replayMessagesFromCursor', err, { connId: connection.id })
  } finally {
    const cursorStr = sinceCursor ? `${sinceCursor.modifiedAt}|${sinceCursor.id}` : 'null'
    console.log(
      `[SessionDO:replay-cursor] sessionId=${ctx.do.name} connId=${connection.id} cursor=${cursorStr} rowCount=${totalRows}${
        firstModifiedAt !== null
          ? ` firstModifiedAt=${firstModifiedAt} lastModifiedAt=${lastModifiedAt}`
          : ''
      }`,
    )
  }
}

/**
 * Spec #101 Stage 6: extracted body of `SessionDO.onError`.
 *
 * Agents base class invokes either `(conn, err)` or `(err)` depending on
 * context. We normalise both, log with full DO state for the GH#61
 * 1006-flap diagnostic capture, and re-throw a real Error object so the
 * SDK's `_tryCatch` wrapper has something useful in the stack — the
 * cause of the session-WS 1ms-flap diagnostic black hole (issue #61).
 */
export function handleOnError(
  ctx: SessionDOContext,
  connection: Connection | unknown,
  error?: unknown,
): never {
  const actualError = error !== undefined ? error : connection
  const conn = error !== undefined ? (connection as Connection) : undefined
  logError(ctx, 'onError', actualError, {
    ...(conn ? { connId: conn.id } : {}),
    status: ctx.state.status,
    hasGateway: !!ctx.do.getGatewayConnectionId(),
    sessionId: ctx.state.session_id ?? 'none',
  })
  throw actualError instanceof Error ? actualError : new Error(String(actualError))
}
