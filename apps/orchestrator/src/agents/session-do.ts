import type {
  BranchInfoRow,
  SyncedCollectionFrame,
  SyncedCollectionOp,
  SessionMessage as WireSessionMessage,
} from '@duraclaw/shared-types'
import { Agent, type Connection, type ConnectionContext, callable } from 'agents'
import type { SessionMessage, SessionMessagePart } from 'agents/experimental/memory/session'
import { Session } from 'agents/experimental/memory/session'
import { and, asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { agentSessions, worktreeReservations } from '~/db/schema'
import { generateActionToken } from '~/lib/action-token'
import { CORE_RUNGS, tryAutoAdvance } from '~/lib/auto-advance'
import type { AwaitingReason, AwaitingResponsePart } from '~/lib/awaiting-response'
import { broadcastSessionRow } from '~/lib/broadcast-session'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import { buildChainRow, isChainSessionCompleted } from '~/lib/chains'
import { chunkOps } from '~/lib/chunk-frame'
import { runMigrations } from '~/lib/do-migrations'
import {
  contentToParts,
  MAX_PARTS_JSON_BYTES,
  offloadOversizedImages,
  sanitizePartsForStorage,
  transcriptUserContentToParts,
} from '~/lib/message-parts'
import { promptToPreviewText } from '~/lib/prompt-preview'
import { type PushPayload, sendPushNotification } from '~/lib/push'
import { sendFcmNotification } from '~/lib/push-fcm'
import type {
  ContentBlock,
  ContextUsage,
  Env,
  GateResponse,
  GatewayCommand,
  GatewayEvent,
  KataSessionState,
  SessionStatus,
  SpawnConfig,
  StructuredAnswer,
} from '~/lib/types'
import { rebindTabsForSession } from '~/lib/update-tab-session'
import { getSessionStatus, killSession, listSessions, parseEvent } from '~/lib/vps-client'
import {
  applyToolResult,
  assistantContentToParts,
  finalizeStreamingParts,
  mergeFinalAssistantParts,
  partialAssistantToParts,
  upsertParts,
} from './gateway-event-mapper'
import {
  buildGatewayCallbackUrl,
  buildGatewayStartUrl,
  claimSubmitId,
  constantTimeEquals,
  deriveSnapshotOps,
  finalizeResultTurn,
  findPendingGatePart,
  getGatewayConnectionId,
  loadTurnState,
  planAwaitingTimeout,
  planClearAwaiting,
  resolveStaleThresholdMs,
} from './session-do-helpers'
import { SESSION_DO_MIGRATIONS } from './session-do-migrations'

/**
 * Internal meta shape — replaces the old public `SessionState` type (#31
 * B10). Fields that are durable across DO rehydrate are persisted to the
 * typed `session_meta` SQLite table (migration v7); transient fields
 * (`updated_at`, `active_callback_token`) stay in the setState JSON blob.
 *
 * Nothing outside session-do.ts should reference this shape — clients now
 * derive status / gate from messages and read summary / cost / turns from
 * D1 via REST.
 */
export interface SessionMeta {
  status: SessionStatus
  session_id: string | null
  project: string
  project_path: string
  model: string | null
  prompt: string
  userId: string | null
  started_at: string | null
  completed_at: string | null
  num_turns: number
  total_cost_usd: number | null
  duration_ms: number | null
  created_at: string
  updated_at: string
  result: string | null
  error: string | null
  summary: string | null
  sdk_session_id: string | null
  active_callback_token?: string
  lastKataMode?: string
  /**
   * GH#73: true when the runner has observed `run-end.json` for the current
   * SDK session. Chain auto-advance gates on `status === 'idle' &&
   * lastRunEnded === true` — kata's Stop hook writes the evidence file only
   * when `can-exit` passes, so this becomes the authoritative "rung
   * finished" signal (no more fragile spec/VP filesystem probes).
   */
  lastRunEnded?: boolean
}

const DEFAULT_META: SessionMeta = {
  status: 'idle',
  session_id: null,
  project: '',
  project_path: '',
  model: null,
  prompt: '',
  userId: null,
  started_at: null,
  completed_at: null,
  num_turns: 0,
  total_cost_usd: null,
  duration_ms: null,
  created_at: '',
  updated_at: '',
  result: null,
  error: null,
  summary: null,
  sdk_session_id: null,
  active_callback_token: undefined,
}

// Map `SessionMeta` keys to their `session_meta` column names. Keys not in
// this map are treated as non-persistent (e.g. `result`, `updated_at` —
// `updated_at` is written explicitly below; `result` is legacy).
const META_COLUMN_MAP: Partial<Record<keyof SessionMeta, string>> = {
  status: 'status',
  session_id: 'session_id',
  project: 'project',
  project_path: 'project_path',
  model: 'model',
  prompt: 'prompt',
  userId: 'user_id',
  started_at: 'started_at',
  completed_at: 'completed_at',
  num_turns: 'num_turns',
  total_cost_usd: 'total_cost_usd',
  duration_ms: 'duration_ms',
  created_at: 'created_at',
  error: 'error',
  summary: 'summary',
  sdk_session_id: 'sdk_session_id',
  active_callback_token: 'active_callback_token',
  lastKataMode: 'last_kata_mode',
  lastRunEnded: 'last_run_ended',
}

/**
 * SessionDO — one Durable Object per CC session.
 *
 * Implements bidirectional relay:
 *   Browser WS <-> SessionDO <-> Gateway WS
 *
 * Persists messages via Session class (agents/experimental/memory/session).
 * Uses @callable RPC methods for spawn, resolveGate, sendMessage, etc.
 */
/**
 * Hibernation-safe alarm interval (ms) for periodic messageSeq D1 flush
 * and recovery-grace deadline expiration. Alarms survive DO hibernation,
 * unlike setInterval which stops when the DO is evicted from memory.
 */
const ALARM_INTERVAL_MS = 30_000
/** GH#57: grace period before running recovery when the gateway reports the
 * runner is still alive. Gives DialBackClient time to reconnect after a
 * transient CF WS flap. If the runner re-dials within this window (detected
 * in onConnectInner), the timer is cancelled and the session resumes. */
const RECOVERY_GRACE_MS = 15_000

/**
 * Parse a canonical user-turn ordinal from a message id or canonical_turn_id.
 * Returns `N` if the id matches `/^usr-(\d+)$/`, otherwise `undefined`.
 * Used by DO cold-start turnCounter recovery (GH#14 P3) and the client
 * sort-key derivation.
 */
function parseTurnOrdinal(id?: string): number | undefined {
  if (!id) return undefined
  const m = /^usr-(\d+)$/.exec(id)
  return m ? Number.parseInt(m[1], 10) : undefined
}

// Stale threshold is resolved per-alarm via resolveStaleThresholdMs(env) so
// config changes take effect on the next DO wake without a code change.
// Default is 90s — see DEFAULT_STALE_THRESHOLD_MS in session-do-helpers.

export class SessionDO extends Agent<Env, SessionMeta> {
  initialState = DEFAULT_META
  private session!: Session
  private turnCounter = 0
  private currentTurnMessageId: string | null = null
  /** Cached gateway connection ID — avoids SQLite reads on every message. */
  private cachedGatewayConnId: string | null = null
  /** Timestamp of the last gateway event received on the WS connection. */
  private lastGatewayActivity = 0
  /** GH#57: pending recovery timer — set when WS drops but gateway says runner
   * is still alive. Cleared when the runner reconnects (onConnectInner). */
  private recoveryGraceTimer: ReturnType<typeof setTimeout> | null = null
  /** Per-session monotonic sequence for MessagesFrame broadcasts (B1). Persisted in typed `session_meta.message_seq`; survives DO rehydrate. */
  private messageSeq = 0
  /**
   * P3 B4: single-flight in-flight probe for `getContextUsage`. Concurrent
   * callers await the same promise; cleared on settle (resolve / reject /
   * timeout) so the next caller can issue a fresh probe.
   */
  private contextUsageProbeInFlight: Promise<ContextUsage | null> | null = null
  /**
   * P3 B4: pending resolvers for the next `context_usage` gateway_event. The
   * handler in `handleGatewayEvent` drains them on arrival. Multiple entries
   * exist only transiently when the probe times out and a new probe races in
   * before the timed-out resolver is swept — the timeout path removes its
   * own slot so late arrivals don't leak.
   */
  private contextUsageResolvers: Array<{
    resolve: (v: ContextUsage | null) => void
    reject: (e: unknown) => void
  }> = []
  /**
   * Cache of the last status+error we synced to D1. Used by `syncStatusToD1` /
   * `syncStatusAndErrorToD1` to short-circuit redundant writes — critical for
   * the belt-and-suspenders hydrate reconciliation (L269-ish), which
   * previously stamped `last_activity = now()` on every DO wake and scrambled
   * the sidebar "Recent" ordering. Initialized from D1 by
   * `initStatusCacheAndReconcile` on hydrate; kept coherent by every write
   * path in `sync*ToD1` below.
   */
  private lastSyncedStatus: SessionStatus | null = null
  private lastSyncedError: string | null = null

  /**
   * GH#50 B9: legacy-event drop log dedupe set. Pre-P3 in-flight runners
   * may continue to send `heartbeat` / `session_state_changed` frames
   * during the deploy window; we want one warn line per type per DO
   * instance, then silent drop.
   */
  private loggedLegacyEventTypes = new Set<string>()

  // ── Lifecycle ──────────────────────────────────────────────────

  async onStart() {
    runMigrations(this.ctx.storage.sql, SESSION_DO_MIGRATIONS)

    // Rehydrate per-session monotonic seq from typed session_meta (B1). The
    // v6 migration INSERT OR IGNOREs row id=1 so the `?? 0` is belt-and-
    // suspenders. Must run before any code path that can broadcastMessages.
    const metaRows = this.sql<{
      message_seq: number
    }>`SELECT message_seq FROM session_meta WHERE id = 1`
    this.messageSeq = metaRows[0]?.message_seq ?? 0

    // Rehydrate ex-SessionState fields from `session_meta` (#31 B10). Merges
    // into the existing state blob so we pick up newly-persisted columns
    // while preserving any transient fields the setState JSON still holds.
    this.hydrateMetaFromSql()

    // GH#65: retrofit oversized `assistant_messages` rows written before the
    // write-path fix landed. Must run BEFORE any code path that reads the
    // `content` column — the SDK's `getHistory()` / cursor replay hit
    // `SQLITE_TOOBIG` on rows that exceed the DO SQLite 2 MB parameter cap
    // and cause the DO to crash uncaught, leaving the session permanently
    // stuck. Gated by the `session_meta.oversized_retrofit_applied_at`
    // once-flag (migration v15) so the scan runs exactly once per DO.
    await this.retrofitOversizedRows()

    this.session = Session.create(this)

    // Trigger Session's lazy table initialization (creates assistant_config etc.)
    // before we query those tables directly via this.sql.
    const pathLength = this.session.getPathLength()

    // Belt-and-suspenders for migration v10: `replayMessagesFromCursor` (and
    // the `modified_at` UPDATE in `safeUpdateMessage`) reference the column
    // unconditionally. The v10 `up` runs in `runMigrations` BEFORE
    // `Session.create(this)` above, so on DOs where the SDK hadn't yet
    // lazy-created `assistant_messages` at v10's runtime, the ALTER caught
    // "no such table" and silently skipped — but `_schema_version` still
    // marks v10 applied, so it never runs again. The SDK later creates the
    // table without the column, and every subsequent subscribe replay
    // throws `no such column: modified_at` — caught in the outer try/catch,
    // so the client silently receives zero history frames. Symptom: session
    // with N turns of persisted state shows an empty chat thread on
    // (re)connect.
    //
    // Re-apply here, AFTER Session.create has guaranteed the table exists.
    // Idempotent: swallows "duplicate column" on DOs where v10 already
    // added the column.
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE assistant_messages ADD COLUMN modified_at TEXT`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.toLowerCase().includes('duplicate column')) {
        console.warn(`[SessionDO:${this.ctx.id}] ensure modified_at column failed`, err)
      }
    }

    // Load persisted turn state from assistant_config
    const turnState = loadTurnState(this.sql.bind(this), pathLength)
    this.turnCounter = turnState.turnCounter
    this.currentTurnMessageId = turnState.currentTurnMessageId

    // Guard against DO eviction: if SQLite history survived but the
    // persisted turnCounter is 0 or stale, scan user-turn IDs for the
    // max ordinal. Prevents canonical-ID collisions (GH#14 P3 B6).
    //
    // GH#57: replaced getHistory() (recursive CTE + ALL content BLOBs,
    // ~25MB for a 500-message session) with a lightweight ID-only query.
    // The old call was the primary cause of "Durable Object storage
    // operation exceeded timeout which caused object to be reset" on
    // large sessions — it fired on EVERY DO wake from hibernation.
    try {
      const userRows = this.sql<{ id: string }>`
        SELECT id FROM assistant_messages
        WHERE session_id = '' AND role = 'user'
      `
      let maxOrdinal = 0
      for (const row of userRows) {
        const ord = parseTurnOrdinal(row.id)
        if (ord !== undefined && ord > maxOrdinal) maxOrdinal = ord
      }
      if (maxOrdinal > this.turnCounter) {
        this.turnCounter = maxOrdinal
      }
    } catch {
      // History scan is best-effort; never fatal on cold start.
    }

    // Populate gateway connection ID cache (in case we're waking from hibernation)
    this.cachedGatewayConnId = getGatewayConnectionId(this.sql.bind(this))

    // Belt-and-suspenders D1 reconciliation. Any prior code path that was
    // supposed to flush `state.status` to `agent_sessions` but silently
    // dropped the write (eviction race, failed UPDATE, transient D1 error)
    // leaves D1 diverged from the DO's in-memory truth. Re-emit on every
    // rehydrate so clients observe the DO's last-known status the next
    // time this DO is loaded — the synced-collection delta pushes the
    // corrected row to the user's UserSettingsDO.
    //
    // NOTE: this path must NOT bump `last_activity`. DO rehydrate is not
    // user activity — stamping `last_activity = now()` every wake caused
    // the sidebar "Recent" list to thrash as DOs were touched by tab
    // navigation, WS reconnects, etc. `initStatusCacheAndReconcile`
    // primes the status cache from D1 first, so the common "D1 already
    // matches" case is a true no-op (no write, no broadcast). Divergent
    // cases still write but leave `last_activity` untouched.
    void this.initStatusCacheAndReconcile()
  }

  /**
   * Handle HTTP requests to the DO. The API route sends POST /create
   * to initialize and spawn a session without requiring a WS connection.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/create') {
      try {
        const body = (await request.json()) as SpawnConfig & {
          userId?: string
          sdk_session_id?: string
          project_path?: string
        }
        const userId = request.headers.get('x-user-id') ?? body.userId ?? null
        if (userId) {
          this.updateState({ userId })
        }

        let result: { ok: boolean; session_id?: string; error?: string }
        if (body.sdk_session_id) {
          // Resume a discovered session
          result = await this.resumeDiscovered(body, body.sdk_session_id)
        } else {
          result = await this.spawn(body)
        }
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 400,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    // Raw message history from the DO's SQLite — for auditing persisted parts
    // (e.g. verifying whether a `tool-ask_user` gate part was ever appended).
    // No gateway hydration: we want exactly what's in local history, nothing
    // merged in from the runner transcript.
    //
    // GH#38 P1.2: Cursor-REST contract — if both `sinceCreatedAt` (ISO 8601)
    // and `sinceId` are present, return rows strictly after `(created_at, id)`
    // sorted ASC capped at 500. Asymmetric cursor (only one supplied) is 400.
    // No cursor: full history via `Session.getHistory()` (cold-load path).
    // Response body drops the legacy `version` field — `messageSeq` now rides
    // on the WS frame envelope, not the REST payload.
    if (request.method === 'GET' && url.pathname === '/messages') {
      try {
        const sinceCreatedAt = url.searchParams.get('sinceCreatedAt')
        const sinceId = url.searchParams.get('sinceId')
        const hasCA = sinceCreatedAt !== null
        const hasId = sinceId !== null
        if (hasCA !== hasId) {
          return new Response(
            JSON.stringify({
              error: 'sinceCreatedAt and sinceId must be provided together',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (hasCA && hasId) {
          if (Number.isNaN(new Date(sinceCreatedAt as string).getTime())) {
            return new Response(
              JSON.stringify({ error: 'invalid sinceCreatedAt ISO 8601 string' }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            )
          }
          // Keyset-paginated cursor query. Uses the composite index
          // idx_assistant_messages_session_created_id created by session-do
          // migration v9 (CREATE INDEX IF NOT EXISTS on the SDK-owned
          // assistant_messages table) so the `(session_id, created_at, id)`
          // predicate + ORDER BY is index-seek, not a table-scan.
          //
          // NOTE: The SDK's `Session.create(this)` (no `.forSession(id)` call)
          // leaves its internal `sessionId` as the empty string, so
          // `AgentSessionProvider` writes every row with `session_id = ''`.
          // Each DO has its own isolated SQLite, so scoping by the DO name
          // is redundant anyway — we match on the literal `''` the SDK
          // actually stores. Querying by `this.name` returned zero rows.
          const rows = this.sql<{
            content: string
            created_at: string
            modified_at: string | null
          }>`
            SELECT content, created_at, modified_at FROM assistant_messages
            WHERE session_id = ''
              AND (
                (created_at > ${sinceCreatedAt as string})
                OR (created_at = ${sinceCreatedAt as string} AND id > ${sinceId as string})
              )
            ORDER BY created_at ASC, id ASC
            LIMIT 500
          `
          const messages: unknown[] = []
          for (const row of rows) {
            try {
              // v13: enrich the REST cold-load payload with `modifiedAt` so
              // the client seeds a correct tail cursor for its next
              // subscribe:messages. Without this, cold-loaded rows fall
              // back to createdAt in computeTailCursor and over-replay.
              const parsed = JSON.parse(row.content) as Record<string, unknown>
              parsed.modifiedAt = row.modified_at ?? row.created_at
              messages.push(parsed)
            } catch {
              // Skip unparseable rows — defensive; Session writes valid JSON.
            }
          }
          return new Response(JSON.stringify({ messages }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
        // Cold-load (no cursor). Historically this called
        // `this.session.getHistory()` — a recursive CTE that walked the full
        // parent chain and read every row's content BLOB. On sessions with
        // inlined base64 images (issue #65) the aggregate read exceeded the
        // DO's storage-operation wall-time, resetting the object and 500-ing
        // the request — preventing resume. Bound to the most recent 500 rows
        // via the same keyset index the cursor branch uses, so the page is an
        // O(500) index seek, not a full-history CTE. WS delta + cursor paging
        // handle any further catch-up.
        const rows = this.sql<{
          content: string
          created_at: string
          modified_at: string | null
        }>`
          SELECT content, created_at, modified_at FROM assistant_messages
          WHERE session_id = ''
          ORDER BY created_at DESC, id DESC
          LIMIT 500
        `
        const buffered: Array<Record<string, unknown>> = []
        for (const row of rows) {
          try {
            const parsed = JSON.parse(row.content) as Record<string, unknown>
            parsed.modifiedAt = row.modified_at ?? row.created_at
            buffered.push(parsed)
          } catch {
            // Skip unparseable rows — defensive; Session writes valid JSON.
          }
        }
        const messages = buffered.reverse()
        return new Response(JSON.stringify({ messages }), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    // GH#38 P1.2: optimistic user-turn ingest via HTTP (used by the
    // `messagesCollection` onInsert mutationFn in P1.3). Body shape:
    // `{content, clientId, createdAt}` — all required. The DO delegates
    // to `sendMessage()` with `client_message_id = clientId` so duplicate
    // retries short-circuit server-side.
    if (request.method === 'POST' && url.pathname === '/messages') {
      try {
        // Gate body size before parsing — a malicious client could POST a
        // multi-GB body that the DO must fully parse before any validation
        // fires. 64 KiB is ample for message content; long-form pastes
        // should use attachments, not the POST body.
        const cl = request.headers.get('content-length')
        if (cl !== null) {
          const bytes = Number(cl)
          if (Number.isFinite(bytes) && bytes > 64 * 1024) {
            return new Response(JSON.stringify({ error: 'payload too large' }), {
              status: 413,
              headers: { 'Content-Type': 'application/json' },
            })
          }
        }
        const body = (await request.json()) as {
          content?: unknown
          clientId?: unknown
          createdAt?: unknown
          senderId?: unknown
        }
        if (typeof body.content !== 'string' || body.content.length === 0) {
          return new Response(JSON.stringify({ error: 'content must be a non-empty string' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (typeof body.clientId !== 'string' || !/^usr-client-[a-z0-9-]+$/.test(body.clientId)) {
          return new Response(
            JSON.stringify({ error: 'clientId must match /^usr-client-[a-z0-9-]+$/' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (
          typeof body.createdAt !== 'string' ||
          Number.isNaN(new Date(body.createdAt).getTime())
        ) {
          return new Response(
            JSON.stringify({ error: 'createdAt must be a valid ISO 8601 string' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const result = await this.sendMessage(body.content, {
          client_message_id: body.clientId,
          createdAt: body.createdAt,
          // Spec #68 B14 — optional sender attribution (no-op today; see
          // the note on sendMessage's opts).
          ...(typeof body.senderId === 'string' ? { senderId: body.senderId } : {}),
        })
        if (!result.ok) {
          // Validation inside sendMessage (e.g. invalid createdAt is
          // caught above, but "status cannot send" returns ok:false).
          return new Response(JSON.stringify({ error: result.error ?? 'send failed' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (result.duplicate) {
          return new Response(JSON.stringify({ id: body.clientId }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ id: body.clientId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    // P3: REST scaffolding for contextUsage (B4). Returns cached value when
    // fresh (<5s), probes the gateway when stale-or-missing, falls back to
    // stale/null when the runner is disconnected.
    if (request.method === 'GET' && url.pathname === '/context-usage') {
      try {
        const body = await this.getContextUsage()
        return new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    // P3: REST scaffolding for kataState (B5). Reads the D1 mirror (source
    // of truth) so the route returns a value even when the runner is dead.
    if (request.method === 'GET' && url.pathname === '/kata-state') {
      try {
        const body = await this.getKataState()
        return new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    // Delegate to Agent base class for WS upgrades and other routes
    return super.onRequest(request)
  }

  // ── GH#65: size-safe persistence wrappers ───────────────────────────
  // Every call site that writes to the Session's SQLite-backed message
  // store should go through these so oversized base64 image data is
  // offloaded to R2 (or truncated as fallback) before it hits the DO
  // SQLite row-size cap (~2 MB).

  /**
   * GH#65 retrofit: on cold start, rewrite any pre-existing oversized rows
   * in `assistant_messages` so the SDK's replay paths (getHistory / cursor
   * replay) can SELECT `content` without hitting `SQLITE_TOOBIG` (CF Workers
   * SQLite caps parameters at ~2 MB).
   *
   * Idempotent via the `session_meta.oversized_retrofit_applied_at`
   * once-flag (migration v15). `LENGTH(content)` is metadata-level and does
   * NOT materialise the BLOB, so the scan works on rows we cannot SELECT.
   *
   * For each oversized row we try to read, parse, and offload its images to
   * R2 (or truncate if the bucket is unavailable). Rows so oversized that
   * even SELECT throws are replaced with a stub text part so the DO can at
   * least boot. Failures to UPDATE an individual row are logged but do not
   * abort the whole scan.
   */
  private async retrofitOversizedRows(): Promise<void> {
    // Honour the once-flag first. Column is on `session_meta` row id=1
    // (migration v6 seeds it). Any non-null value means the scan has run
    // on this DO.
    try {
      const metaRows = this.sql<{ oversized_retrofit_applied_at: string | null }>`
        SELECT oversized_retrofit_applied_at FROM session_meta WHERE id = 1
      `
      if (metaRows[0]?.oversized_retrofit_applied_at) return
    } catch (err) {
      // Column missing (pre-v15 DO that somehow skipped the migration) —
      // the scan is still safe to run; log and continue.
      console.warn(
        `[SessionDO:${this.ctx.id}] retrofitOversizedRows: flag lookup failed, running scan anyway:`,
        err,
      )
    }

    // Identify rows whose serialized content exceeds the threshold. The
    // SDK lazily creates `assistant_messages` on first use — a brand-new DO
    // may not have the table yet. Quietly no-op in that case.
    let oversized: Array<{ id: string; len: number }> = []
    try {
      oversized = this.sql<{ id: string; len: number }>`
        SELECT id, LENGTH(content) AS len
        FROM assistant_messages
        WHERE session_id = '' AND LENGTH(content) > ${MAX_PARTS_JSON_BYTES}
      `
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.toLowerCase().includes('no such table')) {
        console.warn(`[SessionDO:${this.ctx.id}] retrofitOversizedRows: scan failed:`, err)
      }
      // Best-effort — still mark the flag so we don't rescan every wake.
      this.markRetrofitApplied()
      return
    }

    if (oversized.length === 0) {
      this.markRetrofitApplied()
      return
    }

    console.info(
      `[SessionDO:${this.ctx.id}] retrofitOversizedRows: found ${oversized.length} oversized row(s)`,
    )

    for (const row of oversized) {
      const originalBytes = row.len
      let newParts: SessionMessagePart[]
      try {
        // Try to read the content — may throw SQLITE_TOOBIG even on SELECT.
        const contentRows = this.sql<{ content: string }>`
          SELECT content FROM assistant_messages
          WHERE id = ${row.id} AND session_id = '' LIMIT 1
        `
        if (contentRows.length === 0) continue
        const parts = JSON.parse(contentRows[0].content) as SessionMessagePart[]
        await offloadOversizedImages(parts, {
          sessionId: this.name,
          messageId: row.id,
          r2Bucket: this.env.SESSION_MEDIA,
        })
        newParts = parts
      } catch (err) {
        // Row is so oversized even SELECT blows up, or it's malformed.
        // Replace the whole message's parts with a stub so the DO can boot.
        console.warn(
          `[SessionDO:${this.ctx.id}] retrofitOversizedRows: row ${row.id} unreadable (${originalBytes} bytes), replacing with stub:`,
          err,
        )
        newParts = [
          {
            type: 'text',
            text: '[content dropped by GH#65 retrofit — row exceeded SQLite 2 MB cap]',
          },
        ]
      }

      // Rewrite the row. We serialise only `parts` here, but the SDK stores
      // the whole wire message object as JSON. For readable rows we round-
      // trip through the full object; for unreadable rows we build a minimal
      // object. Since the unreadable path cannot read `content`, we build a
      // stand-in using only `id` + stub parts + `role='assistant'` (the SDK
      // treats role=assistant as safe for display; it will be re-replaced on
      // next snapshot if the runner pushes a newer version).
      let newContent: string
      try {
        const contentRows = this.sql<{ content: string; role: string }>`
          SELECT content, role FROM assistant_messages
          WHERE id = ${row.id} AND session_id = '' LIMIT 1
        `
        if (contentRows.length > 0) {
          let base: Record<string, unknown>
          try {
            base = JSON.parse(contentRows[0].content) as Record<string, unknown>
          } catch {
            base = { id: row.id, role: contentRows[0].role }
          }
          base.parts = newParts
          newContent = JSON.stringify(base)
        } else {
          newContent = JSON.stringify({ id: row.id, role: 'assistant', parts: newParts })
        }
      } catch {
        // SELECT itself blew up — build a minimal stub.
        newContent = JSON.stringify({ id: row.id, role: 'assistant', parts: newParts })
      }

      try {
        this.sql`
          UPDATE assistant_messages
          SET content = ${newContent}
          WHERE id = ${row.id} AND session_id = ''
        `
        console.info(
          `[SessionDO:${this.ctx.id}] retrofitOversizedRows: rewrote ${row.id} (${originalBytes} → ${newContent.length} bytes)`,
        )
      } catch (err) {
        console.error(
          `[SessionDO:${this.ctx.id}] retrofitOversizedRows: UPDATE ${row.id} failed:`,
          err,
        )
      }
    }

    this.markRetrofitApplied()
  }

  private markRetrofitApplied(): void {
    const ts = new Date().toISOString()
    try {
      this.sql`
        UPDATE session_meta
        SET oversized_retrofit_applied_at = ${ts}
        WHERE id = 1
      `
    } catch (err) {
      console.warn(`[SessionDO:${this.ctx.id}] markRetrofitApplied failed:`, err)
    }
  }

  /** appendMessage with R2 offload for oversized image parts. */
  private async safeAppendMessage(msg: SessionMessage, parentId?: string | null): Promise<void> {
    await offloadOversizedImages(msg.parts, {
      sessionId: this.name,
      messageId: msg.id,
      r2Bucket: this.env.SESSION_MEDIA,
    })
    const result = this.session.appendMessage(msg, parentId)
    // v13: seed modified_at = created_at on every new row so the unified
    // modified_at cursor in replayMessagesFromCursor can advance past it.
    // Without this seed, freshly-appended rows sit at modified_at=NULL and
    // the strict `modified_at > cursor` predicate excludes them on warm
    // reconnect — symmetric with the inverse bug (excluded update replay)
    // that motivated v10. Best-effort: pre-v10 DOs silently no-op.
    try {
      this
        .sql`UPDATE assistant_messages SET modified_at = created_at WHERE id = ${msg.id} AND session_id = '' AND modified_at IS NULL`
    } catch {
      // Pre-v10 DO — column does not yet exist. Safe to ignore.
    }
    return result
  }

  /**
   * updateMessage with pre-write sanitization of oversized image parts
   * and `modified_at` tracking for cursor-based reconnect replay.
   *
   * Images should already be offloaded to R2 by safeAppendMessage; the
   * sync truncation here is a safety net for the rare case an update
   * somehow carries new image data.
   *
   * Without `modified_at`, `replayMessagesFromCursor` (keyset on
   * `created_at`) can never replay an in-place update to a row whose
   * `created_at` is behind the client's cursor — the root cause of the
   * "final assistant text missing until refresh" bug on long tool-heavy
   * turns where the tab was backgrounded during the turn.
   */
  private safeUpdateMessage(msg: SessionMessage): void {
    sanitizePartsForStorage(msg.parts, {
      sessionId: this.name,
      messageId: msg.id,
    })
    this.session.updateMessage(msg)
    try {
      this
        .sql`UPDATE assistant_messages SET modified_at = ${new Date().toISOString()} WHERE id = ${msg.id} AND session_id = ''`
    } catch {
      // Best-effort — modified_at is a reconnect hint, not a correctness gate.
      // Fails silently if migration v10 hasn't run on this DO yet.
    }
  }

  /**
   * Spec #80 B10: stamp-helper used at every turn-entry point
   * (sendMessage / spawn / forkWithHistory / resubmitMessage) so the
   * awaiting part shape is identical across all four call sites.
   */
  private buildAwaitingPart(reason: AwaitingReason = 'first_token'): AwaitingResponsePart {
    return { type: 'awaiting_response', state: 'pending', reason, startedTs: Date.now() }
  }

  /**
   * Spec #80 B5: scan tail of history for a user message carrying a
   * trailing `awaiting_response@pending` part and strip it. Idempotent —
   * if the tail user has no such part (already cleared, or never stamped)
   * this is a no-op. Failures are swallowed; the P1.4 watchdog is the
   * backstop for persistent awaiting state.
   */
  private clearAwaitingResponse(): void {
    const plan = planClearAwaiting(this.session.getHistory())
    if (plan === null) return
    this.safeUpdateMessage(plan.updated)
    this.broadcastMessages([plan.updated as unknown as WireSessionMessage])
  }

  /**
   * Spec #80 B7: watchdog predicate — invoked from `alarm()` on the 30s
   * cadence (and directly from tests). If the tail user message carries
   * `awaiting_response@pending`, no runner is attached, and the part has
   * aged past `RECOVERY_GRACE_MS`, clear the awaiting part, persist a
   * diagnostic error row, and flip status to `'error'`. Independent of
   * the stale-session branch in `alarm()` because an active awaiting
   * part bumps `last_activity`, so the session does not look stale.
   */
  private async checkAwaitingTimeout(): Promise<void> {
    const decision = planAwaitingTimeout({
      history: this.session.getHistory(),
      connectionId: this.getGatewayConnectionId(),
      now: Date.now(),
      graceMs: RECOVERY_GRACE_MS,
    })
    if (decision.kind === 'noop') return

    // Expired — strip the awaiting part and surface a terminal error row.
    await this.failAwaitingTurn('runner failed to attach within recovery grace')
  }

  /**
   * Spec #80 B7 — terminal failure path for an in-flight awaiting turn.
   * Clears the `awaiting_response@pending` part from the tail user message,
   * appends a `⚠ Error: …` system-message row, flips status to `'error'`,
   * and drops the active callback token so any late runner dial gets
   * 4401'd. Used by:
   *   - `checkAwaitingTimeout()` (alarm-driven, past recovery grace)
   *   - `triggerGatewayDial()`'s two error branches (non-2xx response and
   *     network throw). Without this, the awaiting part + bubble would
   *     hang forever because the two catch-paths set `status:'idle'`
   *     without scheduling a watchdog, and `useDerivedStatus` correctly
   *     keeps returning `'pending'` from the still-present message tail.
   */
  private async failAwaitingTurn(errorText: string): Promise<void> {
    this.clearAwaitingResponse()

    // Persist the error as a visible system message row — mirrors the
    // `case 'error':` path in handleGatewayEvent so the UI has a concrete
    // row to render alongside the status flip.
    this.turnCounter++
    const errorMsgId = `err-${this.turnCounter}`
    const errorMsg: SessionMessage = {
      id: errorMsgId,
      role: 'system',
      parts: [{ type: 'text', text: `⚠ Error: ${errorText}` }],
      createdAt: new Date(),
    }
    await this.safeAppendMessage(errorMsg)
    this.broadcastMessage(errorMsg)

    // Transition to `'error'` with the error text populated — spec #80
    // B7 widens `SessionStatus` to include `'error'` so the watchdog's
    // terminal state renders as a distinct UI badge (red). The system
    // message row above provides the diagnostic detail; the session
    // remains resumable via sdk_session_id.
    this.updateState({
      status: 'error',
      error: errorText,
      active_callback_token: undefined,
    })
    void this.syncStatusToD1(new Date().toISOString())
  }

  onConnect(connection: Connection, ctx: ConnectionContext) {
    // GH#49 + GH#61 observability: log socket-set size + same-id collision
    // count at the moment we enter onConnect. The `[SessionDO][conn] enter`
    // log is the critical diagnostic anchor — if a 1006 close appears in
    // `wrangler tail` WITHOUT a preceding `enter` for the same connId, the
    // throw happened inside the SDK wrapper (before our code runs), pointing
    // to `_setConnectionNoProtocol` or `_ensureConnectionWrapped`. If `enter`
    // appears without `exit`, the throw is in our `onConnectInner`.
    const t0 = Date.now()
    let totalSockets = -1
    let sameIdSockets = -1
    try {
      totalSockets = this.ctx.getWebSockets().length
      sameIdSockets = this.ctx.getWebSockets(connection.id).length
    } catch {
      // getWebSockets can't realistically throw, but don't let observability
      // crash the real handler.
    }
    const role = new URL(ctx.request.url).searchParams.get('role') ?? 'browser'
    console.log(
      `[SessionDO][conn] enter doId=${this.ctx.id} connId=${connection.id} role=${role} totalSockets=${totalSockets} sameIdSockets=${sameIdSockets} status=${this.state.status}`,
    )
    try {
      const result = this.onConnectInner(connection, ctx)
      console.log(
        `[SessionDO][conn] exit doId=${this.ctx.id} connId=${connection.id} role=${role} ms=${Date.now() - t0}`,
      )
      return result
    } catch (err) {
      this.logError('onConnect', err, {
        connId: connection.id,
        role,
        totalSockets,
        sameIdSockets,
        ms: Date.now() - t0,
        status: this.state.status,
      })
      throw err
    }
  }

  private onConnectInner(connection: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url)
    const role = url.searchParams.get('role')

    if (role === 'gateway') {
      // Gateway connection: validate per-dial callback_token minted in
      // triggerGatewayDial. Timing-safe compare; leave token in state so
      // subsequent reconnects by the same session-runner succeed.
      const token = url.searchParams.get('token')
      const active = this.state.active_callback_token
      if (!token || !active || !constantTimeEquals(token, active)) {
        connection.close(4401, 'invalid callback token')
        return
      }

      // Persist gateway connection ID in SQLite (survives hibernation)
      // Do NOT use connection.setState — it conflicts with Agent SDK internals
      this.sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('gateway_conn_id', ${connection.id})`
      this.cachedGatewayConnId = connection.id
      this.lastGatewayActivity = Date.now()

      // GH#57: runner reconnected after a transient WS flap — cancel the
      // pending recovery grace so we don't clear the callback token. The grace
      // lives as both an in-memory setTimeout (fast path) and a durable kv row
      // consulted by alarm() after hibernation; clear both.
      this.clearRecoveryGraceTimer()

      console.log(`[SessionDO:${this.ctx.id}] Gateway connected: conn=${connection.id}`)

      return // No replay, no protocol messages
    }

    // GH#57: sync is cursor-aware delta replay, client-initiated. The old
    // onConnect speculatively pushed full history (~25MB getHistory() on
    // every tab switch / page reload / mobile foreground) and caused DO
    // storage-timeout resets on large sessions. The new contract: the
    // browser sends `{type:'subscribe:messages', sinceCursor}` as its first
    // frame after open (see `onMessage` below); we page the indexed
    // `(session_id, created_at, id)` keyset — bounded, cheap — and
    // broadcast inserts targeted to just that connection.

    // Gate re-emit on reconnect is no longer needed: the
    // messagesCollection snapshot (subscribe:messages) re-surfaces the
    // pending gate via useDerivedGate. (#76 P3)
  }

  /**
   * Suppress all Agent SDK protocol messages (`cf_agent_state`, identity,
   * MCP) for every connection (spec #31 B9). Status / result flow through
   * the D1-mirrored `agent_sessions` row (spec #37), gate derives from
   * messages via `useDerivedGate` (spec #37 B14), and contextUsage /
   * kataState ride the `agent_sessions` synced-collection delta. Returning
   * `false` here silences the legacy state broadcast that no current
   * client consumes.
   */
  shouldSendProtocolMessages(_connection: Connection, _ctx: ConnectionContext): boolean {
    return false
  }

  onMessage(connection: Connection, data: string | ArrayBuffer) {
    try {
      // Check if this is from the gateway connection
      const gwConnId = this.getGatewayConnectionId()
      if (gwConnId && connection.id === gwConnId) {
        // Gateway message: parse and route to handleGatewayEvent
        this.lastGatewayActivity = Date.now()
        try {
          const raw = typeof data === 'string' ? data : new TextDecoder().decode(data)
          const event = parseEvent(raw)
          this.handleGatewayEvent(event)
        } catch (err) {
          this.logError('onMessage.handleGatewayEvent', err)
        }
        return
      }

      // GH#57: intercept cursor-aware sync subscribe BEFORE the @callable
      // dispatcher. The browser advertises its tail cursor so we only
      // replay the gap — cold clients pass null and get everything, warm
      // clients send `(modifiedAt, id)` and get only what they're missing.
      // Frame shape: `{type:'subscribe:messages', sinceCursor: {modifiedAt,id}|null}`.
      //
      // v13 cursor unification: the canonical key is `modifiedAt` (unified
      // insert+update stamp on every row). A legacy client bundle may still
      // send `{createdAt, id}` — in that case we treat createdAt as the
      // modifiedAt floor. This is strictly conservative (it over-replays
      // rather than under-replays) because the legacy client's tail
      // createdAt is always ≤ that row's modifiedAt.
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
          void this.replayMessagesFromCursor(connection, cursor)
          return
        } catch (err) {
          this.logError('onMessage.subscribe:messages', err, { connId: connection.id })
          return
        }
      }

      // Browser message: delegate to Agent base class for @callable RPC dispatch
      super.onMessage(connection, data)
    } catch (err) {
      this.logError('onMessage', err, { connId: connection.id })
      throw err
    }
  }

  onClose(connection: Connection, code: number, reason: string, _wasClean: boolean) {
    try {
      const gwConnId = this.getGatewayConnectionId()
      if (gwConnId && connection.id === gwConnId) {
        console.log(`[SessionDO:${this.ctx.id}] Gateway WS closed: code=${code} reason=${reason}`)
        // Clear the persisted gateway connection ID
        this.cachedGatewayConnId = null
        try {
          this.sql`DELETE FROM kv WHERE key = 'gateway_conn_id'`
        } catch (err) {
          this.logError('onClose.deleteKv', err)
        }

        // If session was active, the connection dropped unexpectedly. Ask the
        // gateway for the runner's live state before running the local recovery
        // path — if the runner is still alive, its DialBackClient will reconnect
        // and we should wait rather than finalizing the DO prematurely.
        if (this.state.status === 'running' || this.state.status === 'waiting_gate') {
          this.maybeRecoverAfterGatewayDrop().catch((err) => {
            this.logError('maybeRecoverAfterGatewayDrop', err)
          })
        }
      } else {
        // GH#49 + GH#61 observability: pair with the `[SessionDO][conn]
        // enter` log so we can see per-connId open→close cycles in
        // `wrangler tail`. `remaining` is the post-close count from
        // ctx.getWebSockets — a non-zero value with the same id on a
        // reconnect-storm means zombie sockets are piling up in the
        // hibernation set.
        let remaining = -1
        try {
          remaining = this.ctx.getWebSockets(connection.id).length
        } catch {
          // no-op
        }
        if (code === 1006) {
          // GH#61: 1006 = abnormal closure — the server-side handler threw
          // without a clean close frame. This is the diagnostic anchor for
          // the "1ms WS flap" pathology. Cross-reference with `[conn] enter`
          // / `[conn] exit` logs for the same connId:
          //   - No `enter` → SDK wrapper threw before our onConnect ran
          //   - `enter` without `exit` → our onConnectInner threw
          //   - Both `enter` + `exit` → SDK post-handler code threw
          console.error(
            `[SessionDO][conn] 1006-diag doId=${this.ctx.id} connId=${connection.id} reason=${JSON.stringify(reason)} sameIdRemaining=${remaining} status=${this.state.status} hasGateway=${!!this.getGatewayConnectionId()} lastGatewayActivity=${this.lastGatewayActivity} sessionId=${this.state.session_id ?? 'none'}`,
          )
        } else {
          console.log(
            `[SessionDO][conn] close doId=${this.ctx.id} connId=${connection.id} code=${code} reason=${JSON.stringify(reason)} sameIdRemaining=${remaining}`,
          )
        }
      }

      super.onClose(connection, code, reason, _wasClean)
    } catch (err) {
      this.logError('onClose', err, { connId: connection.id, code, reason })
      throw err
    }
  }

  onError(connection: Connection | unknown, error?: unknown): void {
    // Agents base class invokes either (conn, err) or (err) depending on
    // context. Normalise both.
    const actualError = error !== undefined ? error : connection
    const conn = error !== undefined ? (connection as Connection) : undefined
    // GH#61: emit full DO state alongside the error so a single wrangler-tail
    // capture is enough to diagnose the 1006 flap without a reproduction.
    this.logError('onError', actualError, {
      ...(conn ? { connId: conn.id } : {}),
      status: this.state.status,
      hasGateway: !!this.getGatewayConnectionId(),
      sessionId: this.state.session_id ?? 'none',
    })
    // Re-throw so the SDK's `_tryCatch` wrapper (index.js:1082) gets a real
    // Error object from the `throw this.onError(e)` line rather than
    // `throw undefined`. Without this, any throw inside onConnect /
    // onMessage surfaces on the client as a bare close 1006 with no stack
    // in wrangler tail — the cause of the session-WS 1ms-flap diagnostic
    // black hole (issue #61). Throwing here satisfies the `void` return
    // type because throwing functions widen to `never`.
    throw actualError instanceof Error ? actualError : new Error(String(actualError))
  }

  /**
   * Unified error logger with full stack trace. Hibernated-DO wakes wrap
   * handler invocations such that unhandled throws surface only as an
   * `Unknown Event - Exception Thrown` tag in wrangler tail — the stack
   * never reaches logs. Explicitly logging here rescues that signal.
   */
  private logError(site: string, err: unknown, extra?: Record<string, unknown>): void {
    const prefix = `[SessionDO:${this.ctx.id}] ERROR@${site}`
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
   * Implements B7 (status-aware recovery). Called from `onClose` for the
   * gateway-role connection. Probes `GET /sessions/:id/status` with a 5s
   * timeout and decides whether to finalize the DO or wait for a re-dial.
   *
   * Defensive fallback: on any unreachable / non-200 / non-404 result, run
   * `recoverFromDroppedConnection` as the DO cannot trust the gateway's
   * liveness signal.
   */
  private async maybeRecoverAfterGatewayDrop() {
    const gatewayUrl = this.env.CC_GATEWAY_URL
    const sessionId = this.state.session_id
    if (!gatewayUrl || !sessionId) {
      await this.recoverFromDroppedConnection()
      return
    }

    const result = await getSessionStatus(gatewayUrl, this.env.CC_GATEWAY_SECRET, sessionId, 5_000)

    if (result.kind === 'state') {
      const runnerState = result.body.state
      // Only 'running' runners can possibly reconnect via DialBackClient
      // backoff. Terminal states (crashed/failed/aborted/completed) mean the
      // runner process is gone — recover immediately instead of burning a
      // 15s grace window waiting for a reconnect that will never happen.
      if (runnerState !== 'running') {
        console.log(
          `[SessionDO:${this.ctx.id}] WS dropped, gateway reports terminal state=${runnerState} — running recovery immediately`,
        )
        await this.recoverFromDroppedConnection()
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
        `[SessionDO:${this.ctx.id}] WS dropped, gateway reports state=running — scheduling recovery grace (${RECOVERY_GRACE_MS}ms, deadline=${deadline})`,
      )
      this.clearRecoveryGraceTimer()
      try {
        this
          .sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('recovery_grace_until', ${String(deadline)})`
      } catch (err) {
        console.warn(`[SessionDO:${this.ctx.id}] Failed to persist recovery_grace_until:`, err)
      }
      // Pull the alarm in to the grace deadline so a hibernation-wake post-
      // deadline runs recovery on the first alarm tick rather than waiting
      // for the next 30s watchdog cycle.
      try {
        this.ctx.storage.setAlarm(deadline)
      } catch (err) {
        console.warn(`[SessionDO:${this.ctx.id}] Failed to set recovery-grace alarm:`, err)
      }
      this.recoveryGraceTimer = setTimeout(async () => {
        this.recoveryGraceTimer = null
        if (this.getGatewayConnectionId()) {
          console.log(
            `[SessionDO:${this.ctx.id}] Recovery grace expired but runner reconnected — skipping recovery`,
          )
          this.clearRecoveryGraceTimer()
          return
        }
        console.log(
          `[SessionDO:${this.ctx.id}] Recovery grace expired, no reconnect — running recovery`,
        )
        await this.recoverFromDroppedConnection()
      }, RECOVERY_GRACE_MS)
      return
    }

    if (result.kind === 'not_found') {
      console.log(`[SessionDO:${this.ctx.id}] WS dropped, gateway 404 — running recovery (orphan)`)
      await this.recoverFromDroppedConnection()
      return
    }

    console.log(
      `[SessionDO:${this.ctx.id}] WS dropped, status unreachable (${result.reason}) — running recovery (defensive)`,
    )
    await this.recoverFromDroppedConnection()
  }

  // ── Gateway Connection ─────────────────────────────────────────

  /**
   * Trigger the gateway to dial back into this DO via outbound WS.
   *
   * Lifecycle per B4b:
   *   1. Mint a fresh callback_token (UUID v4).
   *   2. If a previous token was active, close any live gateway-role WS with
   *      code 4410 ("token rotated") BEFORE persisting the new token — this
   *      prevents an old session-runner from continuing to stream into the DO
   *      concurrently with the newly-spawned runner.
   *   3. Persist the new token via setState (JSON blob — no migration).
   *   4. POST /sessions/start with {callback_url, callback_token, cmd}.
   *   5. On success, persist the gateway-assigned session_id.
   */
  private async triggerGatewayDial(cmd: GatewayCommand) {
    const gatewayUrl = this.env.CC_GATEWAY_URL
    const workerPublicUrl = this.env.WORKER_PUBLIC_URL
    if (!gatewayUrl || !workerPublicUrl) {
      console.error(`[SessionDO:${this.ctx.id}] CC_GATEWAY_URL or WORKER_PUBLIC_URL not configured`)
      this.updateState({ status: 'idle', error: 'Gateway URL or Worker URL not configured' })
      return
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
    if (this.state.active_callback_token) {
      const oldConnId = this.getGatewayConnectionId()
      if (oldConnId) {
        for (const conn of this.getConnections()) {
          if (conn.id === oldConnId) {
            try {
              conn.close(4410, 'token rotated')
            } catch (err) {
              console.error(`[SessionDO:${this.ctx.id}] Failed to close old gateway WS:`, err)
            }
            break
          }
        }
        // Clear the connection-id cache; onClose will also clear but the new
        // runner should not find a stale id in the meantime.
        this.cachedGatewayConnId = null
        try {
          this.sql`DELETE FROM kv WHERE key = 'gateway_conn_id'`
        } catch {
          /* ignore */
        }
      }
    }

    this.updateState({ active_callback_token: callback_token })

    // Build callback URL: wss://worker-url/agents/session-agent/<do-id>?role=gateway&token=<token>
    const callbackUrl = buildGatewayCallbackUrl(
      workerPublicUrl,
      this.ctx.id.toString(),
      callback_token,
    )

    // POST to gateway to trigger dial-back
    const startUrl = buildGatewayStartUrl(gatewayUrl)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.env.CC_GATEWAY_SECRET) {
        headers.Authorization = `Bearer ${this.env.CC_GATEWAY_SECRET}`
      }

      const resp = await fetch(startUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ callback_url: callbackUrl, callback_token, cmd }),
      })

      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'unknown error')
        console.error(`[SessionDO:${this.ctx.id}] Gateway start failed: ${resp.status} ${errText}`)
        // Spec #80 B7 — runner never attached; terminate any stamped
        // awaiting part immediately rather than letting it hang (no
        // watchdog alarm was scheduled on this failure path).
        await this.failAwaitingTurn(`Gateway start failed: ${resp.status}`)
        return
      }

      // Persist the gateway-assigned session_id so subsequent /sessions/:id/status
      // calls use the gateway's canonical id (distinct from the DO id).
      try {
        const parsed = (await resp.json()) as { ok?: boolean; session_id?: string }
        if (parsed?.session_id) {
          this.updateState({ session_id: parsed.session_id })
        }
      } catch (err) {
        console.error(
          `[SessionDO:${this.ctx.id}] Failed to parse gateway /sessions/start body:`,
          err,
        )
      }

      this.lastGatewayActivity = Date.now()
      this.scheduleWatchdog()
      console.log(`[SessionDO:${this.ctx.id}] triggerGatewayDial: POST to gateway succeeded`)
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Gateway start POST failed:`, err)
      // Spec #80 B7 — runner never attached; terminate any stamped
      // awaiting part immediately rather than letting it hang (no
      // watchdog alarm was scheduled on this failure path).
      const msg = err instanceof Error ? err.message : String(err)
      await this.failAwaitingTurn(`Gateway start failed: ${msg}`)
    }
  }

  /** Schedule the next watchdog alarm. */
  /** GH#57: cancel any pending recovery grace (runner reconnected or recovery
   * running through another path). Clears both the in-memory setTimeout and
   * the durable kv deadline consulted by alarm() after hibernation. */
  private clearRecoveryGraceTimer() {
    if (this.recoveryGraceTimer !== null) {
      clearTimeout(this.recoveryGraceTimer)
      this.recoveryGraceTimer = null
    }
    try {
      this.sql`DELETE FROM kv WHERE key = 'recovery_grace_until'`
    } catch {
      // ignore — kv table may not exist on pre-migration DO instances
    }
  }

  private scheduleWatchdog() {
    this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
  }

  /**
   * DO alarm handler — watchdog for stale gateway connections.
   *
   * Fires periodically while a session is "running". If no gateway events
   * have arrived recently and the WS is gone, attempt recovery.
   */
  async alarm() {
    if (
      this.state.status !== 'running' &&
      this.state.status !== 'waiting_gate' &&
      this.state.status !== 'pending'
    ) {
      return // Session not active, no need to watch
    }

    const gwConnId = this.getGatewayConnectionId()

    // Hibernation-safe grace expiry: the in-memory setTimeout in
    // maybeRecoverAfterGatewayDrop is lost if the DO hibernates during the
    // grace window. The alarm is durable, so check the persisted deadline
    // here and run recovery if it has passed and no runner has reconnected.
    try {
      const graceRows = this.sql<{
        value: string
      }>`SELECT value FROM kv WHERE key = 'recovery_grace_until'`
      const graceUntilRaw = graceRows[0]?.value
      if (graceUntilRaw !== undefined) {
        const graceUntil = Number(graceUntilRaw)
        if (Number.isFinite(graceUntil) && Date.now() >= graceUntil) {
          this.sql`DELETE FROM kv WHERE key = 'recovery_grace_until'`
          if (!gwConnId) {
            console.log(
              `[SessionDO:${this.ctx.id}] Watchdog: recovery grace expired (deadline=${graceUntil}) — running recovery`,
            )
            await this.recoverFromDroppedConnection()
            return
          }
          console.log(
            `[SessionDO:${this.ctx.id}] Watchdog: recovery grace expired but runner reconnected — clearing marker`,
          )
        }
      }
    } catch (err) {
      console.warn(`[SessionDO:${this.ctx.id}] Watchdog: recovery_grace read failed:`, err)
    }

    const staleDuration = Date.now() - this.lastGatewayActivity
    const staleThreshold = resolveStaleThresholdMs(this.env.STALE_THRESHOLD_MS)

    if (staleDuration > staleThreshold && !gwConnId) {
      console.log(
        `[SessionDO:${this.ctx.id}] Watchdog: stale for ${Math.round(staleDuration / 1000)}s with no gateway connection — recovering (threshold=${staleThreshold}ms)`,
      )
      await this.recoverFromDroppedConnection()
      return
    }

    // Spec #80 B7: independent predicate — a session with an active
    // awaiting part is not stale (last_activity was just bumped by the
    // user turn), so this must run outside the stale-session branch.
    await this.checkAwaitingTimeout()

    // Still active, schedule next check
    this.scheduleWatchdog()
  }

  /**
   * Attempt to recover session state after the gateway WS dropped.
   *
   * Polls the gateway HTTP API for the latest session transcript,
   * syncs any missed messages, and transitions to the correct status.
   */
  private async recoverFromDroppedConnection() {
    // GH#57: clear any pending grace timer — we're running recovery now.
    this.clearRecoveryGraceTimer()

    // Sync any missed messages from the gateway transcript
    try {
      await this.hydrateFromGateway()
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Recovery hydration failed:`, err)
    }

    // Finalize any streaming parts
    if (this.currentTurnMessageId) {
      const existing = this.session.getMessage(this.currentTurnMessageId)
      if (existing) {
        const finalizedParts = finalizeStreamingParts(existing.parts)
        this.safeUpdateMessage({ ...existing, parts: finalizedParts })
        this.broadcastMessage({ ...existing, parts: finalizedParts })
      }
      this.currentTurnMessageId = null
      this.persistTurnState()
    }

    // Transition to idle (session may be resumable via sdk_session_id).
    // Clear active_callback_token — the runner that owned it is gone.
    this.updateState({
      status: 'idle',
      error: 'Gateway connection lost — session stopped. You can send a new message to resume.',
      active_callback_token: undefined,
    })
    this.syncStatusToD1(new Date().toISOString())

    // Notify connected clients
    this.broadcastToClients(
      JSON.stringify({
        type: 'gateway_event',
        event: { type: 'result', is_error: false, result: 'Connection lost — session idle' },
      }),
    )

    console.log(`[SessionDO:${this.ctx.id}] Recovery: transitioned to idle`)
  }

  // ── Helpers ────────────────────────────────────────────────────

  /**
   * Patch-merge into the Agent's state blob and mirror the durable subset
   * into `session_meta` (migration v7). Fields without a column mapping
   * (e.g. `updated_at`, `result`) stay only in the in-memory JSON blob —
   * clients no longer consume them and DO rehydrate pulls from SQLite.
   */
  private updateState(partial: Partial<SessionMeta>) {
    this.setState({
      ...this.state,
      ...partial,
      updated_at: new Date().toISOString(),
    })
    this.persistMetaPatch(partial)

    // Patch-merge into the Agent's state blob and mirror the durable
    // subset into session_meta.
  }

  private persistMetaPatch(partial: Partial<SessionMeta>) {
    const cols: string[] = []
    const vals: unknown[] = []
    for (const [key, value] of Object.entries(partial) as Array<
      [keyof SessionMeta, SessionMeta[keyof SessionMeta]]
    >) {
      const col = META_COLUMN_MAP[key]
      if (!col) continue
      if (key === 'lastRunEnded') {
        // INTEGER 0/1 column (migration v13). undefined → 0 so the default
        // "not yet ended" state is explicit rather than SQL NULL.
        cols.push(`${col} = ?`)
        vals.push(value ? 1 : 0)
      } else {
        cols.push(`${col} = ?`)
        vals.push(value ?? null)
      }
    }
    if (cols.length === 0) return
    cols.push('updated_at = ?')
    vals.push(Date.now())
    try {
      this.ctx.storage.sql.exec(
        `UPDATE session_meta SET ${cols.join(', ')} WHERE id = 1`,
        ...(vals as (string | number | null)[]),
      )
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] persistMetaPatch failed:`, err)
    }
  }

  /**
   * Rehydrate `this.state` from `session_meta` on onStart (#31 P5). Agent's
   * initialState seed runs once on first wake; on subsequent rehydrates the
   * setState JSON blob is lost if the DO was evicted without a setState
   * call in the final turn — restoring from SQLite keeps `project`,
   * `status`, `session_id`, etc. intact for the next caller.
   */
  private hydrateMetaFromSql() {
    try {
      const rows = this.sql<Record<string, unknown>>`SELECT * FROM session_meta WHERE id = 1`
      const row = rows[0]
      if (!row) return
      const patch: Partial<SessionMeta> = {}
      for (const [key, col] of Object.entries(META_COLUMN_MAP) as Array<
        [keyof SessionMeta, string]
      >) {
        if (!(col in row)) continue
        const raw = row[col]
        if (raw === null || raw === undefined) continue
        if (key === 'lastRunEnded') {
          // INTEGER 0/1 → boolean. GH#73.
          ;(patch as Record<string, unknown>)[key] = raw === 1 || raw === '1' || raw === true
        } else {
          ;(patch as Record<string, unknown>)[key] = raw
        }
      }
      if (Object.keys(patch).length > 0) {
        this.setState({
          ...this.state,
          ...patch,
        })
      }
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] hydrateMetaFromSql failed:`, err)
    }
  }

  private broadcastToClients(data: string) {
    const gwConnId = this.getGatewayConnectionId()
    for (const conn of this.getConnections()) {
      if (conn.id === gwConnId) continue // Skip gateway connection
      try {
        conn.send(data)
      } catch (err) {
        // GH#75 B6: surface broadcast-drop failures so we can diagnose frames
        // that never reach the client (e.g. socket closed mid-send). Parse
        // best-effort to capture the frame type (+ collection for synced
        // deltas) without throwing on unexpected payload shapes.
        let frameType = 'unparseable'
        let collection: string | undefined
        try {
          const parsed = JSON.parse(data) as { type?: unknown; collection?: unknown }
          frameType = typeof parsed.type === 'string' ? parsed.type : 'unknown'
          if (frameType === 'synced-collection-delta' && typeof parsed.collection === 'string') {
            collection = parsed.collection
          }
        } catch {
          frameType = 'unparseable'
        }
        console.warn(
          `[SessionDO:${this.ctx.id}] broadcast drop sessionId=${this.name} connId=${conn.id} frameType=${frameType}${
            collection ? ` collection=${collection}` : ''
          } messageSeq=${this.messageSeq}`,
          err,
        )
      }
    }
  }

  private broadcastGatewayEvent(event: GatewayEvent) {
    this.broadcastToClients(JSON.stringify({ type: 'gateway_event', event }))
  }

  /**
   * Chain auto-advance (spec 16-chain-ux-p1-5 B6 / B7 / B9).
   *
   * Runs on the `stopped` terminal transition for sessions stamped with a
   * `kataIssue` + core `kataMode`. Reads the user's chain auto-advance
   * preference from D1, runs the gate check, and if green spawns the
   * successor session + rebinds the user's open tab(s). Emits
   * `chain_advance` / `chain_stalled` events so the client ChainStatusItem
   * widget can invalidate chain data and surface a toast / warn indicator.
   */
  private async maybeAutoAdvanceChain(): Promise<void> {
    const userId = this.state.userId
    const sessionId = this.state.session_id
    const project = this.state.project
    const kataMode = this.state.lastKataMode
    if (!userId || !sessionId || !project || !kataMode) return
    if (!CORE_RUNGS.has(kataMode)) return

    // kataIssue isn't on SessionMeta — source it from the D1 row we just
    // wrote in syncStatusToD1 above. A single PK lookup; cheap.
    let kataIssue: number | null = null
    try {
      const rows = await this.d1
        .select({ kataIssue: agentSessions.kataIssue })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1)
      kataIssue = rows[0]?.kataIssue ?? null
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] auto-advance: failed to read kataIssue`, err)
      return
    }
    if (kataIssue == null) return

    try {
      const result = await tryAutoAdvance(
        this.env,
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
          runEnded: this.state.lastRunEnded === true,
        },
        this.ctx,
      )
      if (result.action === 'advanced') {
        try {
          await rebindTabsForSession(this.env, userId, sessionId, result.newSessionId, this.ctx)
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] rebindTabsForSession failed:`, err)
        }
        this.broadcastGatewayEvent({
          type: 'chain_advance',
          newSessionId: result.newSessionId,
          nextMode: result.nextMode,
          issueNumber: kataIssue,
        })
      } else if (result.action === 'stalled') {
        this.broadcastGatewayEvent({
          type: 'chain_stalled',
          reason: result.reason,
          issueNumber: kataIssue,
        })
      } else if (result.action === 'error') {
        console.error(`[SessionDO:${this.ctx.id}] auto-advance error: ${result.error}`)
        this.broadcastGatewayEvent({
          type: 'chain_stalled',
          reason: `Auto-advance failed: ${result.error}`,
          issueNumber: kataIssue,
        })
      }
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] auto-advance uncaught error:`, err)
    }
  }

  private broadcastMessage(message: SessionMessage) {
    // SyncedCollectionFrame delta (GH#38 P1.2) — single-row upsert. TanStack
    // DB key-dedupes so insert-on-existing-id updates the row in place.
    this.broadcastMessages([message as unknown as WireSessionMessage])
  }

  /**
   * Compute `BranchInfoRow[]` for every user turn in the given linear history
   * that has siblings (> 1 user-message branch under the same parent).
   *
   * Parent resolution: the Session API (`agents/experimental/memory/session`)
   * exposes `getBranches(messageId)` but no `getParent()`. We derive the
   * parent from the ordering of the linear history — the message immediately
   * preceding a user turn on the active branch is its parent. Turns with no
   * preceding message (the first turn) are skipped.
   *
   * Rows with `siblings.length <= 1` are omitted — the client's
   * `useBranchInfo` only shows arrows when `total > 1` anyway, and this
   * keeps the payload small.
   *
   * See GH#14 B7.
   */
  private computeBranchInfo(history: SessionMessage[]): BranchInfoRow[] {
    const rows: BranchInfoRow[] = []
    const nowIso = new Date().toISOString()
    for (let i = 0; i < history.length; i++) {
      const msg = history[i]
      if (msg.role !== 'user') continue
      const parentId = i > 0 ? history[i - 1].id : null
      if (!parentId) continue
      try {
        const branches = this.session.getBranches(parentId)
        const siblings = branches.filter((m) => m.role === 'user').map((m) => m.id)
        if (siblings.length <= 1) continue
        rows.push({
          parentMsgId: parentId,
          sessionId: this.name,
          siblings,
          activeId: msg.id,
          updatedAt: nowIso,
        })
      } catch {
        // Skip on error — branches may be unresolvable if the Session is
        // mid-mutation; the next snapshot will recompute.
      }
    }
    return rows
  }

  /**
   * Compute a single BranchInfoRow for the parent of `msg` if that parent now
   * has >1 siblings. Returns `undefined` if no parent or no siblings. Used by
   * sendMessage / forkWithHistory to piggyback branch-info onto the user-turn
   * delta (P2 B2).
   */
  private computeBranchInfoForUserTurn(msg: SessionMessage): BranchInfoRow | undefined {
    try {
      // GH#57: replaced getHistory() (O(N) recursive CTE + all BLOBs) with
      // a targeted parent_id lookup. The old call loaded ~25MB for a 500-msg
      // session on every sendMessage, just to find the parent of the new msg.
      const rows = this.sql<{ parent_id: string | null }>`
        SELECT parent_id FROM assistant_messages
        WHERE id = ${msg.id} AND session_id = ''
        LIMIT 1
      `
      const parentId = rows[0]?.parent_id
      if (!parentId) return undefined
      const branches = this.session.getBranches(parentId)
      const siblings = branches.filter((m) => m.role === 'user').map((m) => m.id)
      if (siblings.length <= 1) return undefined
      return {
        parentMsgId: parentId,
        sessionId: this.name,
        siblings,
        activeId: msg.id,
        updatedAt: new Date().toISOString(),
      }
    } catch {
      return undefined
    }
  }

  /**
   * Cursor-aware messages replay (GH#57). Called from `onMessage` when the
   * browser sends `{type:'subscribe:messages', sinceCursor}` as its first
   * frame after WS open. Pages the composite index
   * `idx_assistant_messages_session_created_id` at 500 rows/page and
   * broadcasts each page as a targeted `synced-collection-delta` frame to
   * just the subscribing connection.
   *
   * Replaces the old onConnect full-history push (see onConnectInner).
   * Cold clients send `sinceCursor=null` → replay starts from epoch.
   * Warm clients send their OPFS tail `(createdAt, id)` → we stream only
   * the gap, so tab switches and reconnects with warm caches transfer
   * zero bytes beyond the envelope when there's nothing new.
   *
   * No `getHistory()` call anywhere — each page is an index seek, so the
   * #57 storage-timeout hazard stays closed even for very long sessions.
   */
  private async replayMessagesFromCursor(
    connection: Connection,
    sinceCursor: { modifiedAt: string; id: string } | null,
  ): Promise<void> {
    // v13 unification: cursor keyset is `(modified_at, id)` — the single
    // monotonic "last touch" timestamp stamped by safeAppendMessage
    // (= created_at) and safeUpdateMessage (= now()). The previous
    // created_at cursor with a bolted-on `OR modified_at > cursor.createdAt`
    // clause re-emitted every historically-modified row on every warm
    // reconnect because the cursor never advanced past `modified_at`. See
    // migration v13 description.
    let cursor = sinceCursor ?? { modifiedAt: '1970-01-01T00:00:00.000Z', id: '' }
    // Diagnostic (GH#78 addendum B): track replay totals so we can tell on
    // an idle-session reconnect whether the cursor was stale. If the
    // session is genuinely idle, `modified_at` shouldn't advance while the
    // client is disconnected — so `rowCount > 0` here means the client's
    // sent cursor lagged the server-authoritative max, implicating the
    // client-side cursor-staleness axis (hypotheses B1/B2/B4 in
    // `planning/research/2026-04-23-streaming-reconnect-burst-smoothing.md`).
    // Emit once on exit (any exit path) rather than per-page.
    let totalRows = 0
    let firstModifiedAt: string | null = null
    let lastModifiedAt: string | null = null
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const rows = this.sql<{
          id: string
          created_at: string
          modified_at: string | null
          content: string
        }>`
          SELECT id, created_at, modified_at, content FROM assistant_messages
          WHERE session_id = ''
            AND modified_at IS NOT NULL
            AND (
              (modified_at > ${cursor.modifiedAt})
              OR (modified_at = ${cursor.modifiedAt} AND id > ${cursor.id})
            )
          ORDER BY modified_at ASC, id ASC
          LIMIT 500
        `
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
            this.broadcastMessages({ ops: chunk }, { targetClientId: connection.id })
          }
        }
        if (rows.length < 500) return
        const last = rows[rows.length - 1]
        cursor = { modifiedAt: last.modified_at ?? last.created_at, id: last.id }
      }
    } catch (err) {
      this.logError('replayMessagesFromCursor', err, { connId: connection.id })
    } finally {
      const cursorStr = sinceCursor ? `${sinceCursor.modifiedAt}|${sinceCursor.id}` : 'null'
      console.log(
        `[SessionDO:replay-cursor] sessionId=${this.name} connId=${connection.id} cursor=${cursorStr} rowCount=${totalRows}${
          firstModifiedAt !== null
            ? ` firstModifiedAt=${firstModifiedAt} lastModifiedAt=${lastModifiedAt}`
            : ''
        }`,
      )
    }
  }

  /**
   * Broadcast a messages `SyncedCollectionFrame` (GH#38 P1.2). Every row
   * becomes one `{type:'insert', value: SessionMessage}` op — TanStack DB's
   * key-based upsert dedupes so insert-on-existing-id updates in place, no
   * need to discriminate insert-vs-update at emit time.
   *
   * For rewind / resubmit / branch-navigate (P1.4), callers pass a
   * pre-built ops array via `{ ops }` so delete ops can be emitted
   * alongside inserts in the same frame.
   *
   * `targetClientId` keeps its pre-existing semantics: targeted sends do
   * NOT advance `messageSeq` (the envelope counter echoes the current
   * value) so non-recipients stay aligned with the shared stream.
   */
  private broadcastMessages(
    rowsOrOps: WireSessionMessage[] | { ops: SyncedCollectionOp<WireSessionMessage>[] },
    opts: { targetClientId?: string } = {},
  ): void {
    const rawOps: SyncedCollectionOp<WireSessionMessage>[] = Array.isArray(rowsOrOps)
      ? rowsOrOps.map((r) => ({ type: 'insert' as const, value: r }))
      : rowsOrOps.ops
    if (rawOps.length === 0) return

    // v13: stamp `modifiedAt` on every insert/update wire value that doesn't
    // already carry one. The replay path (replayMessagesFromCursor) pre-
    // stamps values from the SQL `modified_at` column; all other live and
    // snapshot paths land here unstamped. Using `new Date().toISOString()`
    // at emit time keeps the invariant `T_wire >= T_sql` — the SQL UPDATEs
    // in safeAppendMessage / safeUpdateMessage run sequentially before the
    // broadcast, so a client cursor advanced to T_wire can never cause the
    // same row to re-qualify on the next subscribe:messages.
    const now = new Date().toISOString()

    if (!opts.targetClientId) {
      this.messageSeq += 1
      this.persistMessageSeq()
    }

    // GH#76 follow-up: stamp `seq` on every outbound row so the client's
    // `useDerivedStatus` hook can detect when the messages collection is
    // ahead of the D1-mirrored `agent_sessions.message_seq` tiebreaker.
    // Without this, `msg.seq` is always undefined on the wire → the hook's
    // `localMaxSeq` stays at -1 → the tiebreaker `serverSeq (-1 default)
    // >= localMaxSeq (-1)` is always true → the hook returns undefined and
    // every consumer falls through to the stale D1 row (the regression
    // that #76 was supposed to fix, not cause). Targeted sends don't bump
    // `messageSeq`, so they echo the current value — same semantics as the
    // frame envelope counter.
    const rowSeq = this.messageSeq
    const ops: SyncedCollectionOp<WireSessionMessage>[] = rawOps.map((op) => {
      if (op.type === 'delete') return op
      const value = op.value
      if (!value || typeof value !== 'object') return op
      const next: WireSessionMessage = { ...value, seq: rowSeq }
      if (!next.modifiedAt) next.modifiedAt = now
      return { ...op, value: next }
    })
    const frame: SyncedCollectionFrame<WireSessionMessage> = {
      type: 'synced-collection-delta',
      collection: `messages:${this.name}`,
      ops,
      messageSeq: this.messageSeq,
      // GH#75: targeted sends (cursor-replay, requestSnapshot reply)
      // bypass client gap-gating. Clients install `lastSeq = max(lastSeq,
      // messageSeq)` after applying and apply ops even when the current
      // watermark is ahead.
      ...(opts.targetClientId ? { targeted: true as const } : {}),
    }
    const data = JSON.stringify(frame)
    if (opts.targetClientId) {
      this.sendToClient(opts.targetClientId, data)
    } else {
      this.broadcastToClients(data)
    }
  }

  /**
   * Broadcast a branchInfo `SyncedCollectionFrame` (GH#38 P1.5 / B15).
   * Emitted as a sibling frame alongside the messages frame on the same
   * DO turn — React 18 auto-batching delivers both deltas in a single
   * commit (B10 atomicity).
   *
   * Callers pass the full authoritative branchInfo list for the current
   * history view (typically `this.computeBranchInfo(history)`). Rows
   * collapse to `{type:'insert', value}` ops; TanStack DB key-dedupes on
   * `parentMsgId` so insert-on-existing-id updates in place.
   *
   * Targeted sends (onConnect replay) do NOT advance `messageSeq`; the
   * envelope echoes the current value so non-recipients stay aligned.
   */
  private broadcastBranchInfo(rows: BranchInfoRow[], opts: { targetClientId?: string } = {}): void {
    if (rows.length === 0 && !opts.targetClientId) return
    if (!opts.targetClientId) {
      this.messageSeq += 1
      this.persistMessageSeq()
    }
    const ops: SyncedCollectionOp<BranchInfoRow>[] = rows.map((value) => ({
      type: 'insert' as const,
      value,
    }))
    const frame: SyncedCollectionFrame<BranchInfoRow> = {
      type: 'synced-collection-delta',
      collection: `branchInfo:${this.name}`,
      ops,
      messageSeq: this.messageSeq,
      // GH#75: same targeted-frame contract as broadcastMessages — the
      // snapshot / cursor-replay path delivers branchInfo rows in
      // lockstep with the messages frame and both must bypass client
      // gap-gating.
      ...(opts.targetClientId ? { targeted: true as const } : {}),
    }
    const data = JSON.stringify(frame)
    if (opts.targetClientId) {
      this.sendToClient(opts.targetClientId, data)
    } else {
      this.broadcastToClients(data)
    }
  }

  /**
   * Persist the current `messageSeq` to `session_meta`. Called unconditionally
   * from `broadcastMessages` / `broadcastBranchInfo` after incrementing
   * `this.messageSeq` (GH#69 B4 — unconditional to eliminate hibernation-
   * rewind risk). Fire-and-forget per the liveness-signal contract: a SQLite
   * write failure must not crash the broadcast pipeline.
   */
  private persistMessageSeq(): void {
    try {
      this
        .sql`UPDATE session_meta SET message_seq = ${this.messageSeq}, updated_at = ${Date.now()} WHERE id = 1`
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to persist message_seq to SQLite:`, err)
    }
  }

  /** Send raw stringified payload to a specific client connection (skips gateway conn). */
  private sendToClient(connectionId: string, data: string) {
    const gwConnId = this.getGatewayConnectionId()
    for (const conn of this.getConnections()) {
      if (conn.id === gwConnId) continue
      if (conn.id !== connectionId) continue
      try {
        conn.send(data)
      } catch {
        // Connection already closed — drop silently
      }
      return
    }
  }

  /**
   * Promote an existing tool-use part (created by the `assistant` event) to a
   * gate part so the UI renders a GateResolver instead of a plain tool pill.
   *
   * Scans ALL messages (latest first) for a part whose `toolCallId` matches,
   * then flips its `type`, `toolName`, and `state` in place.  This avoids the
   * old approach of appending a *second* part via a message-ID lookup that
   * could miss when `turnCounter` drifted between the `assistant` and gate
   * events.
   *
   * If no matching part is found (edge case: the `assistant` event hasn't
   * been processed yet, or was lost), a standalone assistant message is
   * created as a fallback so the gate is never silently dropped.
   */
  private promoteToolPartToGate(
    toolCallId: string,
    newType: string,
    newToolName: string,
    input: Record<string, unknown>,
  ): 'promoted' | 'already-resolved' | 'no-part' {
    // Walk messages newest-first looking for the part the assistant event
    // already created (type = `tool-{SdkToolName}`, toolCallId matches).
    const history = this.session.getHistory()
    let promoted = false
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i]
      const idx = msg.parts.findIndex((p) => p.toolCallId === toolCallId)
      if (idx === -1) continue

      // Race guard: with the SDK-native direct-render path, a fast user can
      // submit before this `ask_user` event reaches the DO. If the matching
      // part is already in a terminal output state (resolveGate ran first),
      // do NOT regress `state` back to `approval-requested` — that re-opens
      // the GateResolver in the UI and leaves it stuck. Return
      // 'already-resolved' so the caller skips its scalar-gate side
      // effects too.
      const existingState = msg.parts[idx].state
      if (
        existingState === 'output-available' ||
        existingState === 'output-error' ||
        existingState === 'output-denied' ||
        existingState === 'approval-given' ||
        existingState === 'approval-denied'
      ) {
        return 'already-resolved'
      }

      const updatedParts = [...msg.parts]
      updatedParts[idx] = {
        ...updatedParts[idx],
        type: newType,
        toolName: newToolName,
        input: updatedParts[idx].input ?? input, // keep SDK input if present
        state: 'approval-requested',
      }
      const updatedMsg: SessionMessage = { ...msg, parts: updatedParts }
      try {
        this.safeUpdateMessage(updatedMsg)
        this.broadcastMessage(updatedMsg)
      } catch (err) {
        console.error('[session-do] event persist failed', err)
      }
      promoted = true
      break
    }

    // Fallback: assistant event hasn't created the part yet — create a
    // standalone message so the gate is never invisible.
    if (!promoted) {
      console.warn(
        `[SessionDO:${this.ctx.id}] promoteToolPartToGate: no part with toolCallId '${toolCallId}' — creating standalone gate message`,
      )
      const gateMsg: SessionMessage = {
        id: `gate-${toolCallId}`,
        role: 'assistant',
        parts: [
          {
            type: newType,
            toolCallId,
            toolName: newToolName,
            input,
            state: 'approval-requested',
          },
        ],
        createdAt: new Date(),
      }
      try {
        void this.safeAppendMessage(gateMsg)
        this.broadcastMessage(gateMsg)
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] Failed to create standalone gate:`, err)
      }
      return 'no-part'
    }
    return 'promoted'
  }

  private persistTurnState() {
    try {
      this
        .sql`INSERT OR REPLACE INTO assistant_config (session_id, key, value) VALUES ('', 'turnCounter', ${String(this.turnCounter)})`
      this
        .sql`INSERT OR REPLACE INTO assistant_config (session_id, key, value) VALUES ('', 'currentTurnMessageId', ${this.currentTurnMessageId ?? ''})`
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to persist turn state:`, err)
    }
  }

  /**
   * Drizzle handle scoped to this DO's request env. Lazy-init per call so
   * the binding is always fresh. As of #7 p6 D1 is the sole metadata
   * source of truth — the previous SESSION_REGISTRY DO fan-out is gone.
   */
  private get d1() {
    return drizzle(this.env.AUTH_DB, { schema })
  }

  private async syncStatusToD1(updatedAt: string, opts: { bumpLastActivity?: boolean } = {}) {
    try {
      const sessionId = this.name
      const newStatus = this.state.status
      const shouldClearError = newStatus === 'running' || newStatus === 'idle'
      const nextError = shouldClearError ? null : this.lastSyncedError
      // Fast no-op: nothing to reconcile. Prevents spurious lastActivity
      // bumps + delta-frame broadcasts on hydrate reconciliation and on
      // same-status re-emits that would otherwise scramble the sidebar
      // "Recent" ordering (sessions jumping around on every DO wake).
      if (this.lastSyncedStatus === newStatus && this.lastSyncedError === nextError) {
        return
      }
      const bumpLastActivity = opts.bumpLastActivity !== false
      await this.d1
        .update(agentSessions)
        .set({
          status: newStatus,
          updatedAt,
          messageSeq: this.messageSeq,
          ...(bumpLastActivity ? { lastActivity: updatedAt } : {}),
          ...(shouldClearError ? { error: null, errorCode: null } : {}),
        })
        .where(eq(agentSessions.id, sessionId))
      await broadcastSessionRow(this.env, this.ctx, sessionId, 'update')
      this.lastSyncedStatus = newStatus
      this.lastSyncedError = nextError
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync status to D1:`, err)
    }
  }

  /**
   * Hydrate-path reconciliation. Reads the current `status` + `error` from
   * D1 to prime `lastSyncedStatus` / `lastSyncedError`, then calls
   * `syncStatusToD1` with `bumpLastActivity: false` so the belt-and-
   * suspenders reconcile never touches `last_activity`. If D1 already
   * matches the DO's in-memory state, the subsequent sync is a no-op via
   * the cache fast path — no write, no broadcast, no sidebar jitter.
   */
  private async initStatusCacheAndReconcile() {
    try {
      const sessionId = this.name
      const rows = await this.d1
        .select({ status: agentSessions.status, error: agentSessions.error })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1)
      const row = rows[0]
      if (row) {
        this.lastSyncedStatus = row.status as SessionStatus
        this.lastSyncedError = row.error ?? null
      }
    } catch {
      // Best-effort prime. If the read fails the cache stays null and the
      // next write path will issue a real UPDATE + broadcast — same as
      // the prior behaviour.
    }
    void this.syncStatusToD1(new Date().toISOString(), { bumpLastActivity: false })
  }

  private async syncResultToD1(updatedAt: string) {
    try {
      const sessionId = this.name
      await this.d1
        .update(agentSessions)
        .set({
          summary: this.state.summary,
          durationMs: this.state.duration_ms,
          totalCostUsd: this.state.total_cost_usd,
          numTurns: this.state.num_turns,
          messageSeq: this.messageSeq,
          updatedAt,
          lastActivity: updatedAt,
        })
        .where(eq(agentSessions.id, sessionId))
      await broadcastSessionRow(this.env, this.ctx, sessionId, 'update')
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync result to D1:`, err)
    }
  }

  private async syncSdkSessionIdToD1(sdkSessionId: string, updatedAt: string) {
    try {
      const sessionId = this.name
      await this.d1
        .update(agentSessions)
        .set({ sdkSessionId, messageSeq: this.messageSeq, updatedAt })
        .where(eq(agentSessions.id, sessionId))
      await broadcastSessionRow(this.env, this.ctx, sessionId, 'update')
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync sdk_session_id to D1:`, err)
    }
  }

  /**
   * Consolidated status + error write: one UPDATE, one broadcast. Preserves
   * `syncStatusToD1`'s `shouldClearError` semantics — when `errorMsg` is null
   * and the new status is `running` / `idle`, clears `error` + `errorCode`.
   * When `errorMsg` is non-null, sets error + errorCode as provided regardless
   * of status.
   */
  private async syncStatusAndErrorToD1(
    status: SessionStatus,
    errorMsg: string | null,
    errorCode: string | null,
    updatedAt: string,
  ) {
    try {
      const sessionId = this.name
      const shouldClearError = errorMsg == null && (status === 'running' || status === 'idle')
      const errorFields =
        errorMsg != null
          ? { error: errorMsg, errorCode }
          : shouldClearError
            ? { error: null, errorCode: null }
            : {}
      await this.d1
        .update(agentSessions)
        .set({
          status,
          updatedAt,
          messageSeq: this.messageSeq,
          lastActivity: updatedAt,
          ...errorFields,
        })
        .where(eq(agentSessions.id, sessionId))
      await broadcastSessionRow(this.env, this.ctx, sessionId, 'update')
      // Keep the cache coherent so the next `syncStatusToD1` fast-path
      // reflects this write. Without this, a subsequent same-status
      // `syncStatusToD1` call could spuriously write again (not broken,
      // but wasteful).
      this.lastSyncedStatus = status
      this.lastSyncedError =
        errorMsg != null ? errorMsg : shouldClearError ? null : this.lastSyncedError
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync status+error to D1:`, err)
    }
  }

  /**
   * Consolidated kata write: one UPDATE for all kata columns
   * (kataMode, kataIssue, kataPhase, kataStateJson) + one broadcast.
   * Also refreshes the worktree reservation activity and broadcasts the
   * chain row, mirroring `syncKataToD1`'s side effects.
   */
  private async syncKataAllToD1(kataState: KataSessionState | null, updatedAt: string) {
    try {
      const sessionId = this.name
      await this.d1
        .update(agentSessions)
        .set({
          kataMode: kataState?.currentMode ?? null,
          kataIssue: kataState?.issueNumber ?? null,
          kataPhase: kataState?.currentPhase ?? null,
          kataStateJson: kataState ? JSON.stringify(kataState) : null,
          messageSeq: this.messageSeq,
          updatedAt,
        })
        .where(eq(agentSessions.id, sessionId))
      await broadcastSessionRow(this.env, this.ctx, sessionId, 'update')
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync kata (all) to D1:`, err)
    }

    // Mirror `syncKataToD1` side effects: refresh worktree reservation
    // last_activity_at (clears stale flag) and broadcast updated chains row.
    if (kataState?.issueNumber != null && this.state.project) {
      try {
        await this.d1
          .update(worktreeReservations)
          .set({ lastActivityAt: updatedAt, stale: false })
          .where(
            and(
              eq(worktreeReservations.issueNumber, kataState.issueNumber),
              eq(worktreeReservations.worktree, this.state.project),
            ),
          )
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] failed to refresh reservation activity:`, err)
      }
    }

    this.broadcastChainUpdate(kataState?.issueNumber ?? null)
  }

  // Spec #37 P1b: defined but not yet wired — there is no callsite in this
  // DO that builds a WorktreeInfo JSON object today. Leaving this in place
  // so the follow-up (worktree-info resolution) can attach without a new
  // helper. Do not remove.
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: intentional, see above
  private async syncWorktreeInfoToD1(worktreeInfoJson: string | null, updatedAt: string) {
    try {
      const sessionId = this.name
      await this.d1
        .update(agentSessions)
        .set({ worktreeInfoJson, messageSeq: this.messageSeq, updatedAt })
        .where(eq(agentSessions.id, sessionId))
      await broadcastSessionRow(this.env, this.ctx, sessionId, 'update')
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync worktree_info_json to D1:`, err)
    }
  }

  // 5s trailing-edge debounce for context_usage D1 writes — matches the
  // session_meta.context_usage_cached_at TTL. See spec #37 B5.
  private contextUsageDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingContextUsageJson: string | null = null

  private syncContextUsageToD1(json: string) {
    this.pendingContextUsageJson = json
    if (this.contextUsageDebounceTimer) return
    this.contextUsageDebounceTimer = setTimeout(() => {
      this.contextUsageDebounceTimer = null
      const pending = this.pendingContextUsageJson
      this.pendingContextUsageJson = null
      if (pending == null) return
      void (async () => {
        try {
          const sessionId = this.name
          const updatedAt = new Date().toISOString()
          await this.d1
            .update(agentSessions)
            .set({ contextUsageJson: pending, messageSeq: this.messageSeq, updatedAt })
            .where(eq(agentSessions.id, sessionId))
          await broadcastSessionRow(this.env, this.ctx, sessionId, 'update')
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] Failed to sync context_usage to D1:`, err)
        }
      })()
    }, 5000)
  }

  /**
   * GH#50 B9: tolerant log-once-then-drop for legacy event types
   * (`heartbeat`, `session_state_changed`) emitted by pre-P3 runners
   * during the rollout window. Liveness bump (B1) runs BEFORE this drop
   * so the legacy frame still refreshes the TTL — clients with P2
   * shipped never see a flap.
   */
  private handleLegacyEvent(type: string, sessionId: string | null) {
    if (!this.loggedLegacyEventTypes.has(type)) {
      console.warn(
        `[session-do] dropped legacy event type=${type} sessionId=${sessionId ?? 'unknown'}`,
      )
      this.loggedLegacyEventTypes.add(type)
    }
  }

  /**
   * Rebuild the ChainSummary for `issueNumber` and broadcast the delta op
   * to the owning user's UserSettingsDO. Fire-and-forget via `waitUntil`
   * so D1 write → broadcast latency doesn't stack on the caller.
   */
  private broadcastChainUpdate(issueNumber: number | null) {
    if (issueNumber == null || !Number.isFinite(issueNumber)) return
    const userId = this.state.userId
    if (!userId) return

    this.ctx.waitUntil(
      (async () => {
        try {
          const row = await buildChainRow(this.env, this.d1, userId, issueNumber)
          if (row) {
            await broadcastSyncedDelta(this.env, userId, 'chains', [{ type: 'update', value: row }])
          } else {
            await broadcastSyncedDelta(this.env, userId, 'chains', [
              { type: 'delete', key: String(issueNumber) },
            ])
          }
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] broadcastChainUpdate failed:`, err)
        }
      })(),
    )
  }

  /**
   * Chain UX P4 — mode-enter session reset.
   *
   * Triggered when a chain-linked session observes a `kata_state` event with
   * a different `currentMode` than previously seen and `continueSdk` is not
   * set. Flushes the outbound channel, kicks the active runner WS with close
   * code 4411 (mode_transition), waits up to 5s for the runner to exit, then
   * spawns a fresh runner in the new mode with an artifact-pointer preamble.
   */
  private async handleModeTransition(kataState: KataSessionState, fromMode: string | null) {
    const sessionId = this.name
    const toMode = kataState.currentMode ?? ''
    const issueNumber = kataState.issueNumber ?? 0

    console.log(
      `[SessionDO:${this.ctx.id}] mode transition ${fromMode ?? '(none)'}→${toMode} issue=#${issueNumber}`,
    )

    // 1. Announce the transition to browsers so the chain timeline UI picks it up.
    this.broadcastGatewayEvent({
      type: 'mode_transition',
      session_id: sessionId,
      from: fromMode,
      to: toMode,
      issueNumber,
      at: new Date().toISOString(),
    })

    // 2. Flush window — BufferedChannel has no in-flight-send introspection,
    //    so the best we can do is a short pause to let the runner's final
    //    pre-transition events land before we slam the WS shut.
    await new Promise((r) => setTimeout(r, 2000))

    // 3. Close the runner WS with 4411 (mode_transition). Mirrors the 4410
    //    rotation path in triggerGatewayDial.
    const gwConnId = this.getGatewayConnectionId()
    if (gwConnId) {
      for (const conn of this.getConnections()) {
        if (conn.id === gwConnId) {
          try {
            conn.close(4411, 'mode_transition')
          } catch (err) {
            console.error(
              `[SessionDO:${this.ctx.id}] Failed to close runner WS on mode transition:`,
              err,
            )
          }
          break
        }
      }
      this.cachedGatewayConnId = null
      try {
        this.sql`DELETE FROM kv WHERE key = 'gateway_conn_id'`
      } catch {
        /* ignore */
      }
      // Explicitly clear the callback token so the poll below proceeds on the
      // happy path. onClose only clears this when status is running/waiting_gate,
      // which doesn't cover every mode-transition case — without this clear the
      // poll below always falls through to the 5s timeout.
      this.updateState({ active_callback_token: undefined })
    }

    // 4. Wait up to 5s for the runner to exit — signalled by the DO's onClose
    //    handler clearing `active_callback_token` (or the token rotating to a
    //    new value). Poll state.active_callback_token at 100ms granularity.
    const startTok = this.state.active_callback_token
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
        const tok = this.state.active_callback_token
        if (!tok || tok !== startTok) done(true)
      }
      const interval = setInterval(check, 100)
      const timeout = setTimeout(() => done(false), 5000)
      check()
    })

    if (!exited) {
      console.warn(
        `[SessionDO:${this.ctx.id}] mode transition: runner did not exit within 5s — proceeding (token rotation in triggerGatewayDial will evict lingering runner via 4410)`,
      )
      this.broadcastGatewayEvent({
        type: 'mode_transition_timeout',
        session_id: sessionId,
        issueNumber,
        at: new Date().toISOString(),
        note: 'runner did not exit within 5s; proceeding with fresh spawn',
      })
    }

    // 5. Build preamble (degrade gracefully on failure).
    const preamble = await this.buildModePreamble(kataState)

    // 6. Spawn fresh runner in the new mode. triggerGatewayDial handles any
    //    lingering runner via 4410 rotation.
    await this.triggerGatewayDial({
      type: 'execute',
      project: this.state.project,
      prompt: preamble,
      agent: toMode,
      model: this.state.model ?? 'sonnet',
    })
  }

  /**
   * Build the artifact-pointer preamble prepended to the fresh runner's first
   * prompt on a chain mode transition. Queries D1 for prior sessions linked
   * to the same issueNumber and emits a one-line pointer per completed mode.
   * On any failure, falls back to the degraded template from the spec and
   * emits `mode_transition_preamble_degraded` so the UI can surface it.
   */
  private async buildModePreamble(ks: KataSessionState): Promise<string> {
    const issueNumber = ks.issueNumber ?? 0
    const mode = ks.currentMode ?? 'unknown'
    const phase = ks.currentPhase ?? 'p0'
    const sessionId = this.name

    // Issue title is not a first-class field on the DO — leave as 'untitled'
    // until chain metadata plumbing lands (downstream P5 work).
    const issueTitle = 'untitled'

    const degraded = () =>
      `You are entering ${mode} mode for issue #${issueNumber}. Prior-artifact listing is unavailable — use the kata CLI (\`kata status\`) to inspect chain state. Your kata state is already linked: workflowId=GH#${issueNumber}, mode=${mode}, phase=${phase}.`

    try {
      const rows = await this.d1
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
        // finished rungs park as 'idle' with a non-null lastActivity. Use the
        // shared predicate so this stays aligned with the client-side
        // chain-progression gates (see lib/chains.ts).
        if (!isChainSessionCompleted({ status: row.status, lastActivity: row.lastActivity }))
          continue
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
      console.error(`[SessionDO:${this.ctx.id}] buildModePreamble failed:`, err)
      this.broadcastGatewayEvent({
        type: 'mode_transition_preamble_degraded',
        session_id: sessionId,
        issueNumber,
        at: new Date().toISOString(),
        reason,
      })
      return degraded()
    }
  }

  /**
   * Fetch SDK session transcript from the VPS gateway and persist via Session.
   * Called on first getMessages() for discovered sessions with empty history.
   */
  /**
   * Fetch SDK session transcript from the VPS gateway and persist via Session.
   *
   * Skips the first `skipCount` user/assistant messages that are already
   * persisted locally. When called with skipCount=0 (default) on a session
   * that already has messages, it effectively skips nothing but also doesn't
   * duplicate — the skipCount should match the number of user+assistant
   * messages already in the Session tree.
   */
  private async hydrateFromGateway() {
    const gatewayUrl = this.env.CC_GATEWAY_URL
    if (!gatewayUrl || !this.state.sdk_session_id || !this.state.project) return

    const httpBase = gatewayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    const url = new URL(
      `/projects/${encodeURIComponent(this.state.project)}/sessions/${encodeURIComponent(this.state.sdk_session_id)}/messages`,
      httpBase,
    )
    const headers: Record<string, string> = {}
    if (this.env.CC_GATEWAY_SECRET) {
      headers.Authorization = `Bearer ${this.env.CC_GATEWAY_SECRET}`
    }

    try {
      const resp = await fetch(url.toString(), { headers })
      if (!resp.ok) {
        console.error(
          `[SessionDO:${this.ctx.id}] Gateway hydration failed: ${resp.status} ${resp.statusText}`,
        )
        return
      }
      const data = (await resp.json()) as {
        messages: Array<{ type: string; uuid: string; content: unknown[] }>
      }
      if (!data.messages?.length) return

      // Count how many user/assistant messages we already have locally.
      // We skip that many from the gateway transcript to avoid duplicates.
      const localHistory = this.session.getPathLength()
      let skipped = 0

      let persisted = 0
      let lastMsgId: string | null = null
      // Tracks the in-progress assistant message across multi-cycle turns so
      // that consecutive SDK `assistant` events (text → tool_use per cycle)
      // merge into a single local message, matching live-stream behavior.
      // Reset on every `user` event (turn boundary).
      let currentAssistantMsgId: string | null = null

      // If we have local messages, set lastMsgId to the latest one so new
      // messages get appended to the end of the existing tree. If the tail is
      // an assistant message, treat it as the in-progress turn accumulator so
      // new assistant events from the transcript merge into it (multi-cycle
      // turns where live streaming already built a merged message).
      if (localHistory > 0) {
        const history = this.session.getHistory()
        if (history.length > 0) {
          const tail = history[history.length - 1]
          lastMsgId = tail.id
          if (tail.role === 'assistant') {
            currentAssistantMsgId = tail.id
          }
        }
      }

      for (const msg of data.messages) {
        // Skip user/assistant messages we already persisted
        if (msg.type === 'user' || msg.type === 'assistant') {
          if (skipped < localHistory) {
            skipped++
            continue
          }
        }
        // Also skip tool_results that belong to already-persisted messages
        if (msg.type === 'tool_result' && skipped <= localHistory && persisted === 0) {
          continue
        }

        if (msg.type === 'user') {
          // Filter out tool_result blocks from user message content — those are handled
          // as separate tool_result events. If only tool_result blocks remain, skip entirely.
          let content = msg.content
          if (Array.isArray(content)) {
            const filtered = content.filter(
              (c: unknown) => (c as Record<string, unknown>)?.type !== 'tool_result',
            )
            if (filtered.length === 0) {
              // User message contained only tool_result blocks — skip
              continue
            }
            content = filtered
          }

          this.turnCounter++
          const msgId = `usr-${this.turnCounter}`
          const sessionMsg: SessionMessage = {
            id: msgId,
            role: 'user',
            parts: transcriptUserContentToParts(content),
            createdAt: new Date(),
          }
          await this.safeAppendMessage(sessionMsg, lastMsgId)
          lastMsgId = msgId
          // A new user message ends any in-progress assistant turn — reset the
          // accumulator so the next assistant event starts a fresh message.
          currentAssistantMsgId = null
          persisted++
        } else if (msg.type === 'assistant') {
          const newParts = assistantContentToParts(msg.content)
          if (currentAssistantMsgId) {
            // Same turn as the previous assistant event (multi-cycle Claude
            // response) — merge parts into the existing message to mirror the
            // live-streaming merge behavior. Otherwise tool pills get split
            // across N messages and lose their grouping in the UI.
            //
            // Dedupe-on-merge via `upsertParts`: SDK transcript replay after
            // a gate resolution re-emits already-persisted tool_use blocks
            // (same toolCallId). A naive concat duplicates them and, worse,
            // un-promotes any gate part that was promoted in-place
            // (GH#59). `upsertParts` keeps promotion sticky and prevents
            // state regression from terminal states.
            const existing = this.session.getMessage(currentAssistantMsgId)
            if (existing) {
              this.safeUpdateMessage({
                ...existing,
                parts: upsertParts(existing.parts, newParts),
              })
              persisted++
              continue
            }
          }
          this.turnCounter++
          const msgId = `msg-${this.turnCounter}`
          const sessionMsg: SessionMessage = {
            id: msgId,
            role: 'assistant',
            parts: newParts,
            createdAt: new Date(),
          }
          await this.safeAppendMessage(sessionMsg, lastMsgId)
          lastMsgId = msgId
          currentAssistantMsgId = msgId
          persisted++
        } else if (msg.type === 'tool_result') {
          // Apply tool results to the last assistant message
          if (lastMsgId) {
            const existing = this.session.getMessage(lastMsgId)
            if (existing) {
              const updatedParts = applyToolResult(existing.parts, msg)
              this.safeUpdateMessage({ ...existing, parts: updatedParts })
            }
          }
          persisted++
        }
      }
      if (persisted > 0) {
        this.persistTurnState()
      }
      console.log(
        `[SessionDO:${this.ctx.id}] Hydrated ${persisted} new events (skipped ${skipped} existing) from gateway for sdk_session=${this.state.sdk_session_id.slice(0, 12)}`,
      )
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Gateway hydration error:`, err)
    }
  }

  private sendToGateway(cmd: GatewayCommand) {
    const gwConnId = this.getGatewayConnectionId()
    if (!gwConnId) {
      console.error(`[SessionDO:${this.ctx.id}] Cannot send to gateway: no active connection`)
      return
    }
    // Find the matching connection from the Hibernation API
    for (const conn of this.getConnections()) {
      if (conn.id === gwConnId) {
        try {
          conn.send(JSON.stringify(cmd))
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] Failed to send to gateway:`, err)
        }
        return
      }
    }
    console.error(
      `[SessionDO:${this.ctx.id}] Gateway connection ${gwConnId} not found in active connections`,
    )
  }

  /** Read the gateway connection ID, using in-memory cache when available. */
  private getGatewayConnectionId(): string | null {
    if (this.cachedGatewayConnId) return this.cachedGatewayConnId
    // Fallback to SQLite (e.g. after hibernation wake)
    const id = getGatewayConnectionId(this.sql.bind(this))
    this.cachedGatewayConnId = id
    return id
  }

  private async dispatchPush(payload: PushPayload, eventType: 'blocked' | 'completed' | 'error') {
    const tag = `[push:dispatch ${this.ctx.id}]`
    const userId = this.state.userId
    if (!userId) {
      console.log(`${tag} no userId on state — skipping`)
      return
    }

    console.log(
      `${tag} begin`,
      JSON.stringify({
        eventType,
        url: payload.url,
        tag: payload.tag,
        sessionId: payload.sessionId,
        hasActions: payload.actions?.length ?? 0,
        hasActionToken: Boolean(payload.actionToken),
        userId,
      }),
    )

    const vapidPublicKey = this.env.VAPID_PUBLIC_KEY
    const vapidPrivateKey = this.env.VAPID_PRIVATE_KEY
    const vapidSubject = this.env.VAPID_SUBJECT
    if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
      console.log(`${tag} VAPID not configured — skipping`)
      return
    }

    // Check user preferences cascade
    try {
      const prefs = await this.env.AUTH_DB.prepare(
        'SELECT key, value FROM user_preferences WHERE user_id = ? AND key LIKE ?',
      )
        .bind(userId, 'push.%')
        .all<{ key: string; value: string }>()

      const prefMap = new Map(prefs.results.map((r) => [r.key, r.value]))

      // Master toggle
      if (prefMap.get('push.enabled') === 'false') {
        console.log(`${tag} push.enabled=false — skipping`)
        return
      }

      // Event-specific toggle
      const prefKey = `push.${eventType}`
      if (prefMap.get(prefKey) === 'false') {
        console.log(`${tag} ${prefKey}=false — skipping`)
        return
      }
    } catch (err) {
      console.error(`${tag} preference lookup failed (continuing as opt-in):`, err)
    }

    // Fetch subscriptions
    let subscriptions: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>
    try {
      const result = await this.env.AUTH_DB.prepare(
        'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
      )
        .bind(userId)
        .all<{ id: string; endpoint: string; p256dh: string; auth: string }>()
      subscriptions = result.results
    } catch (err) {
      console.error(`${tag} subscription lookup failed:`, err)
      return
    }

    console.log(`${tag} ${subscriptions.length} subscription(s)`)
    if (subscriptions.length === 0) return

    const vapid = { publicKey: vapidPublicKey, privateKey: vapidPrivateKey, subject: vapidSubject }

    // Send to all subscriptions (best-effort, no retry)
    for (const sub of subscriptions) {
      const endpointSummary = sub.endpoint.slice(0, 60)
      const result = await sendPushNotification(sub, payload, vapid)
      console.log(
        `${tag} send sub=${sub.id} endpoint=${endpointSummary}... ok=${result.ok} status=${result.status ?? 'n/a'} gone=${Boolean(result.gone)}`,
      )
      if (result.gone) {
        // 410 Gone — delete stale subscription
        try {
          await this.env.AUTH_DB.prepare('DELETE FROM push_subscriptions WHERE id = ?')
            .bind(sub.id)
            .run()
          console.log(`${tag} deleted stale subscription ${sub.id}`)
        } catch (err) {
          console.error(`${tag} failed to delete stale subscription ${sub.id}:`, err)
        }
      }
    }

    // FCM fan-out (Capacitor Android shell). Reads `FCM_SERVICE_ACCOUNT_JSON`
    // — a Worker secret containing the Firebase service account JSON. Opt-in:
    // when unset, the FCM path is silently skipped (no Capacitor deployment).
    const fcmServiceAccount = this.env.FCM_SERVICE_ACCOUNT_JSON
    if (fcmServiceAccount) {
      let fcmRows: Array<{ id: string; token: string }> = []
      try {
        const fcmResult = await this.env.AUTH_DB.prepare(
          'SELECT id, token FROM fcm_subscriptions WHERE user_id = ?',
        )
          .bind(userId)
          .all<{ id: string; token: string }>()
        fcmRows = fcmResult.results
      } catch (err) {
        console.error(`${tag} fcm subscription lookup failed:`, err)
      }

      if (fcmRows.length > 0) {
        console.log(`${tag} fcm ${fcmRows.length} subscription(s)`)
        for (const row of fcmRows) {
          try {
            const tokenSummary = row.token.slice(0, 16)
            const result = await sendFcmNotification(row.token, payload, fcmServiceAccount)
            console.log(
              `${tag} fcm send sub=${row.id} token=${tokenSummary}... ok=${result.ok} status=${result.status ?? 'n/a'} gone=${Boolean(result.gone)}`,
            )
            if (result.gone) {
              try {
                await this.env.AUTH_DB.prepare('DELETE FROM fcm_subscriptions WHERE id = ?')
                  .bind(row.id)
                  .run()
                console.log(`${tag} fcm deleted stale subscription ${row.id}`)
              } catch (err) {
                console.error(`${tag} fcm failed to delete stale subscription ${row.id}:`, err)
              }
            }
          } catch (err) {
            console.error(`${tag} fcm send threw for sub=${row.id}:`, err)
          }
        }
      }
    }
  }

  // ── @callable RPC Methods ─────────────────────────────────────

  /**
   * Retry the gateway dial — used by the DisconnectedBanner when the
   * client WS is alive but no gateway-role runner is connected. If the
   * session has an `sdk_session_id` we resume from the on-disk JSONL;
   * otherwise there's nothing to reconnect to. Idempotent: calling
   * twice just re-POSTs to the gateway.
   */
  @callable()
  async reattach(): Promise<{ ok: boolean; error?: string }> {
    const hasLiveRunner = Boolean(this.getGatewayConnectionId())
    if (hasLiveRunner) {
      return { ok: true } // already connected
    }
    if (!this.state.sdk_session_id) {
      return { ok: false, error: 'No sdk_session_id — nothing to reattach' }
    }
    if (!this.state.project) {
      return { ok: false, error: 'No project set — cannot dial gateway' }
    }
    if (!this.env.CC_GATEWAY_URL || !this.env.WORKER_PUBLIC_URL) {
      return {
        ok: false,
        error: 'Gateway not configured (missing CC_GATEWAY_URL or WORKER_PUBLIC_URL)',
      }
    }

    this.updateState({ status: 'running', error: null })
    this.syncStatusToD1(new Date().toISOString())
    void this.triggerGatewayDial({
      type: 'resume',
      project: this.state.project,
      prompt: '',
      sdk_session_id: this.state.sdk_session_id,
    })
    return { ok: true }
  }

  /**
   * Force-resume from the on-disk JSONL transcript — the escape hatch when
   * the DO thinks the session is `running` but the WS is dead and normal
   * reattach can't proceed. Rotates the callback token (which 4401-kills
   * any orphan runner), then triggers a fresh `resume` dial. The orphan
   * runner sees `4410 token_rotated` on its WS, aborts, and exits cleanly.
   */
  @callable()
  async resumeFromTranscript(): Promise<{ ok: boolean; error?: string }> {
    if (!this.state.sdk_session_id) {
      return { ok: false, error: 'No sdk_session_id — nothing to resume' }
    }
    if (!this.state.project) {
      return { ok: false, error: 'No project set — cannot dial gateway' }
    }
    if (!this.env.CC_GATEWAY_URL || !this.env.WORKER_PUBLIC_URL) {
      return {
        ok: false,
        error: 'Gateway not configured (missing CC_GATEWAY_URL or WORKER_PUBLIC_URL)',
      }
    }

    // triggerGatewayDial handles token rotation internally — it closes
    // the old gateway WS with 4410 before POSTing to spawn a new runner.
    // That 4410 is what kills the orphan.
    this.updateState({ status: 'running', error: null })
    this.syncStatusToD1(new Date().toISOString())
    void this.triggerGatewayDial({
      type: 'resume',
      project: this.state.project,
      prompt: '',
      sdk_session_id: this.state.sdk_session_id,
    })
    return { ok: true }
  }

  @callable()
  async spawn(config: SpawnConfig): Promise<{ ok: boolean; session_id?: string; error?: string }> {
    // 'pending' is the post-spawn intermediate state (spec #80) flipped
    // below at line 3102 before the runner's first event lands. Without
    // it in the guard, a concurrent second spawn() — always fired by
    // AgentDetailWithSpawn once the WS opens on draft→real tab swap —
    // races past this idempotency check, appends a second `usr-N`
    // message, and broadcasts it. Symptom: two identical user bubbles
    // on new-session-draft first submit.
    if (
      this.state.status === 'running' ||
      this.state.status === 'waiting_gate' ||
      this.state.status === 'pending'
    ) {
      return { ok: false, error: 'Session already active' }
    }

    const now = new Date().toISOString()
    const id = this.ctx.id.toString()

    const freshState: SessionMeta = {
      ...DEFAULT_META,
      status: 'running',
      session_id: id,
      userId: this.state.userId,
      project: config.project,
      project_path: config.project,
      model: config.model ?? null,
      // Store a readable preview, not a JSON blob of base64 image data —
      // see `~/lib/prompt-preview`. Message parts preserve the full
      // ContentBlock[] fidelity; `SessionMeta.prompt` is only for state
      // snapshots / logs.
      prompt: promptToPreviewText(config.prompt),
      started_at: now,
      created_at: this.state.created_at || now,
      updated_at: now,
    }
    this.setState(freshState)
    this.persistMetaPatch(freshState)

    // Persist initial prompt as a user message so it survives reload
    this.turnCounter++
    const userMsgId = `usr-${this.turnCounter}`
    const userMsg: SessionMessage & { canonical_turn_id?: string } = {
      id: userMsgId,
      role: 'user',
      parts: [...contentToParts(config.prompt), this.buildAwaitingPart('first_token')],
      createdAt: new Date(),
      canonical_turn_id: userMsgId,
    }
    try {
      await this.safeAppendMessage(userMsg)
      this.persistTurnState()
      this.broadcastMessage(userMsg)
    } catch (err) {
      console.error(`[SessionDO:${id}] Failed to persist initial prompt:`, err)
    }
    // Spec #80 B2: flip status to 'pending' so UI renders the awaiting
    // bubble while we wait on the first runner event.
    this.updateState({ status: 'pending', error: null })
    void this.syncStatusToD1(new Date().toISOString())

    void this.triggerGatewayDial({
      type: 'execute',
      project: config.project,
      prompt: config.prompt,
      model: config.model,
      agent: config.agent,
      system_prompt: config.system_prompt,
      allowed_tools: config.allowed_tools,
      max_turns: config.max_turns,
      max_budget_usd: config.max_budget_usd,
    })

    console.log(
      `[SessionDO:${id}] spawn: ${config.project} "${typeof config.prompt === 'string' ? config.prompt.slice(0, 80) : '[content blocks]'}"`,
    )
    return { ok: true, session_id: id }
  }

  /**
   * Resume a discovered VPS session by sdk_session_id.
   * Called from the /create handler when sdk_session_id is present.
   */
  private async resumeDiscovered(
    config: SpawnConfig,
    sdkSessionId: string,
  ): Promise<{ ok: boolean; session_id?: string; error?: string }> {
    // Mirror spawn()'s guard — 'pending' is an active state (spec #80).
    if (
      this.state.status === 'running' ||
      this.state.status === 'waiting_gate' ||
      this.state.status === 'pending'
    ) {
      return { ok: false, error: 'Session already active' }
    }

    const now = new Date().toISOString()
    const id = this.ctx.id.toString()

    const resumeState: SessionMeta = {
      ...DEFAULT_META,
      status: 'running',
      session_id: id,
      userId: this.state.userId,
      project: config.project,
      project_path: config.project,
      model: config.model ?? null,
      // Readable preview — not a JSON blob. See `~/lib/prompt-preview`.
      prompt: promptToPreviewText(config.prompt),
      started_at: now,
      created_at: this.state.created_at || now,
      updated_at: now,
      sdk_session_id: sdkSessionId,
    }
    this.setState(resumeState)
    this.persistMetaPatch(resumeState)

    // Persist resume prompt as a user message — use contentToParts so
    // image-paste resumes preserve the image/text block fidelity instead
    // of collapsing to a single text part with stringified JSON.
    this.turnCounter++
    const userMsgId = `usr-${this.turnCounter}`
    const userMsg: SessionMessage & { canonical_turn_id?: string } = {
      id: userMsgId,
      role: 'user',
      parts: contentToParts(config.prompt),
      createdAt: new Date(),
      canonical_turn_id: userMsgId,
    }
    try {
      await this.safeAppendMessage(userMsg)
      this.persistTurnState()
      this.broadcastMessage(userMsg)
    } catch (err) {
      console.error(`[SessionDO:${id}] Failed to persist resume prompt:`, err)
    }

    void this.triggerGatewayDial({
      type: 'resume',
      project: config.project,
      prompt: config.prompt,
      sdk_session_id: sdkSessionId,
      agent: config.agent,
    })

    console.log(
      `[SessionDO:${id}] resumeDiscovered: ${config.project} sdk_session=${sdkSessionId.slice(0, 12)}`,
    )
    return { ok: true, session_id: id }
  }

  @callable()
  async stop(reason?: string): Promise<{ ok: boolean; error?: string }> {
    if (this.state.status !== 'running' && this.state.status !== 'waiting_gate') {
      return { ok: false, error: `Cannot stop: status is '${this.state.status}'` }
    }

    // Transition unilaterally so stop unsticks sessions even when the gateway WS
    // is half-open / dead. The gateway send is best-effort — its ack can't be
    // trusted to arrive, so we don't gate local recovery on it.
    this.updateState({
      status: 'idle',
      error: null,
      active_callback_token: undefined,
    })
    this.syncStatusToD1(new Date().toISOString())

    const gwConnId = this.getGatewayConnectionId()
    if (gwConnId) {
      this.sendToGateway({ type: 'stop', session_id: this.state.session_id ?? '' })
    }

    console.log(`[SessionDO:${this.ctx.id}] stop: ${reason ?? 'user request'}`)
    return { ok: true }
  }

  @callable()
  async abort(reason?: string): Promise<{ ok: boolean; error?: string }> {
    if (this.state.status !== 'running' && this.state.status !== 'waiting_gate') {
      return { ok: false, error: `Cannot abort: status is '${this.state.status}'` }
    }

    this.updateState({
      status: 'idle',
      error: null,
      active_callback_token: undefined,
    })
    this.sendToGateway({ type: 'abort', session_id: this.state.session_id ?? '' })
    this.syncStatusToD1(new Date().toISOString())
    console.log(`[SessionDO:${this.ctx.id}] abort: ${reason ?? 'user request'}`)
    return { ok: true }
  }

  /**
   * Force-stop a wedged session. This is the escalation lever exposed to
   * the UI when a previous `interrupt` / `stop` hasn't settled — typically
   * because the dial-back WS is dead (runner still alive on the VPS, but
   * the in-band `abort` command never reaches it).
   *
   * Transition-wise this matches `abort`: we flip status → idle
   * unilaterally and drop the callback token. The delta vs `abort` is the
   * out-of-band HTTP call to `POST /sessions/:id/kill` on the gateway,
   * which SIGTERMs the runner by PID straight from its `.pid` file. Even
   * if the WS command is lost in flight, the process goes away.
   *
   * Returns a classified outcome so the caller can surface failures
   * (timeout / gateway unreachable / pid not found). The DO has already
   * locally recovered regardless — `forceStop` never leaves the DO in a
   * weird state.
   */
  @callable()
  async forceStop(reason?: string): Promise<{
    ok: boolean
    error?: string
    kill:
      | { kind: 'skipped'; reason: 'no_gateway_url' | 'no_session_id' }
      | { kind: 'signalled'; pid: number; sigkill_grace_ms: number }
      | { kind: 'already_terminal'; state: string }
      | { kind: 'not_found' }
      | { kind: 'unreachable'; reason: string }
  }> {
    if (this.state.status !== 'running' && this.state.status !== 'waiting_gate') {
      return {
        ok: false,
        error: `Cannot force-stop: status is '${this.state.status}'`,
        kill: { kind: 'skipped', reason: 'no_session_id' },
      }
    }

    const sessionId = this.state.session_id
    this.updateState({
      status: 'idle',
      error: null,
      active_callback_token: undefined,
    })

    // Best-effort in-band abort — harmless if the WS is dead.
    if (sessionId) {
      this.sendToGateway({ type: 'abort', session_id: sessionId })
    }
    this.syncStatusToD1(new Date().toISOString())

    // Out-of-band SIGTERM via gateway HTTP. This is the slice that
    // actually rescues the stuck-runner case.
    const gatewayUrl = this.env.CC_GATEWAY_URL
    let killResult:
      | { kind: 'skipped'; reason: 'no_gateway_url' | 'no_session_id' }
      | { kind: 'signalled'; pid: number; sigkill_grace_ms: number }
      | { kind: 'already_terminal'; state: string }
      | { kind: 'not_found' }
      | { kind: 'unreachable'; reason: string }
    if (!gatewayUrl) {
      killResult = { kind: 'skipped', reason: 'no_gateway_url' }
    } else if (!sessionId) {
      killResult = { kind: 'skipped', reason: 'no_session_id' }
    } else {
      killResult = await killSession(gatewayUrl, this.env.CC_GATEWAY_SECRET, sessionId, 5_000)
    }

    console.log(
      `[SessionDO:${this.ctx.id}] forceStop: ${reason ?? 'user request'} kill=${killResult.kind}`,
    )
    return { ok: true, kill: killResult }
  }

  private flattenStructuredAnswers(answers: StructuredAnswer[]): string {
    const parts: string[] = []
    for (const a of answers) {
      const label = (a.label ?? '').trim()
      const note = (a.note ?? '').trim()
      if (label && note) parts.push(`${label} (note: ${note})`)
      else if (label) parts.push(label)
      else if (note) parts.push(note)
    }
    return parts.join('; ')
  }

  @callable()
  async resolveGate(
    gateId: string,
    response: GateResponse,
  ): Promise<{ ok: boolean; error?: string }> {
    // Relaxed: accept resolveGate in any status. The CLI terminal may have
    // already resolved the tool (advancing status to 'running'), but the web
    // UI still has the GateResolver mounted. Rejecting here just blocks the
    // user with a confusing error. The gate-id lookup below is the real guard
    // — if the part was already resolved, findPendingGatePart returns null and
    // we return a clean "not found" error instead of a status mismatch.

    // Look up the pending gate part directly from history (#76 P3 —
    // scalar state.gate removed; messages are the sole source of truth).
    const match = findPendingGatePart(this.session.getHistory(), gateId)
    const gate: { id: string; type: 'ask_user' | 'permission_request' } | null = match
      ? { id: gateId, type: match.type }
      : null

    if (!gate) {
      return {
        ok: false,
        error: `Gate '${gateId}' not found (no pending part in history)`,
      }
    }

    if (gate.type === 'permission_request' && response.approved !== undefined) {
      this.sendToGateway({
        type: 'permission-response',
        session_id: this.state.session_id ?? '',
        tool_call_id: gateId,
        allowed: response.approved,
      })
    } else if (gate.type === 'ask_user') {
      let flatAnswer: string | undefined
      if (response.declined === true) {
        // User dismissed the question by typing a new message. Feed the
        // SDK a placeholder tool-result so its pending AskUserQuestion
        // callback completes and the runner unblocks to accept the next
        // stream-input turn.
        flatAnswer = '[User declined to answer. See subsequent message for next instruction.]'
      } else if (response.answers !== undefined) {
        flatAnswer = this.flattenStructuredAnswers(response.answers)
      } else if (response.answer !== undefined) {
        flatAnswer = response.answer
      }
      if (flatAnswer === undefined) {
        return { ok: false, error: 'Invalid response for gate type' }
      }
      this.sendToGateway({
        type: 'answer',
        session_id: this.state.session_id ?? '',
        tool_call_id: gateId,
        answers: { answer: flatAnswer },
      })
    } else {
      return { ok: false, error: 'Invalid response for gate type' }
    }

    // Update the message part state for the resolved gate.  Scan all
    // messages (newest-first) for the matching toolCallId rather than
    // guessing the message ID via currentTurnMessageId / turnCounter — the
    // part may live in any message after promoteToolPartToGate.
    const history = this.session.getHistory()
    let partUpdated = false
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i]
      const partIdx = msg.parts.findIndex((p) => p.toolCallId === gateId)
      if (partIdx === -1) continue

      const updatedParts = msg.parts.map((p) => {
        if (p.toolCallId !== gateId) return p
        if (response.declined === true) {
          // ask_user dismissed by a follow-up user message — render as
          // "User declined to answer" via ResolvedAskUser's denied branch.
          return { ...p, state: 'output-denied', output: 'User declined to answer' }
        }
        if (response.approved !== undefined) {
          return {
            ...p,
            state: response.approved ? 'output-available' : 'output-denied',
            ...(response.approved && response.answer ? { output: response.answer } : {}),
          }
        }
        if (response.answers !== undefined) {
          return { ...p, state: 'output-available', output: { answers: response.answers } }
        }
        if (response.answer !== undefined) {
          return { ...p, state: 'output-available', output: response.answer }
        }
        return p
      })
      const updatedMsg: SessionMessage = { ...msg, parts: updatedParts }
      try {
        this.safeUpdateMessage(updatedMsg)
      } catch (err) {
        // updateMessage can fail if the message was garbage-collected,
        // created via the standalone fallback path, or the DO rehydrated
        // from hibernation with stale session state. Log but still
        // broadcast so the client UI clears the gate.
        console.error(`[SessionDO:${this.ctx.id}] resolveGate: updateMessage failed:`, err)
      }
      // Always broadcast even if updateMessage threw — the client needs
      // the part-state flip to clear its GateResolver. Without this the
      // UI stays stuck showing the gate prompt with no error feedback.
      try {
        this.broadcastMessage(updatedMsg)
        partUpdated = true
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] resolveGate: broadcastMessage failed:`, err)
        return {
          ok: false,
          error: 'Gate answer sent to agent but failed to update UI — retry or reload',
        }
      }
      break
    }

    if (!partUpdated) {
      // The gateway command was already sent (answer delivered to runner),
      // but we couldn't find the message part to flip its state. The UI
      // gate will stay visible until the next message broadcast refreshes
      // the part. Return an error so the client can surface it.
      console.error(
        `[SessionDO:${this.ctx.id}] resolveGate: no message part found for toolCallId '${gateId}' — answer sent to agent but UI not updated`,
      )
      return {
        ok: false,
        error: 'Answer sent but gate UI may not clear — try reloading if it stays visible',
      }
    }

    this.updateState({ status: 'running' })
    // Mirror the status flip into D1 so `sessionsCollection.status` (and
    // the "Needs Attention" chip fed by it when `useDerivedStatus` yields
    // to the D1 fallback) clears promptly. Without this, resolving a
    // permission gate flips the DO's in-memory status but leaves
    // `agent_sessions.status` stale at `waiting_gate` until the next
    // event (assistant turn / result) triggers a sync — visible as a
    // stuck amber chip after approve/deny.
    this.syncStatusToD1(new Date().toISOString())
    return { ok: true }
  }

  @callable()
  async sendMessage(
    content: string | ContentBlock[],
    opts?: {
      submitId?: string
      client_message_id?: string
      createdAt?: string
      // Spec #68 B14 — accepted for forward-compat when shared sessions
      // need to attribute turns to the sender. The column exists on the
      // SDK-owned `assistant_messages` table (migration v11) but message
      // persistence flows through `Session.appendMessage`, not direct
      // SQL, so this is a no-op today. Plumbed now so the wire shape is
      // stable when UI attribution lands.
      senderId?: string
    },
  ): Promise<{
    ok: boolean
    error?: string
    recoverable?: 'forkWithHistory'
    duplicate?: boolean
    id?: string
  }> {
    // Idempotency: if a submitId was supplied and we've already accepted it,
    // treat this as a duplicate of that prior call and no-op. Rows older than
    // 60s are pruned on each insert to cap table growth.
    if (opts?.submitId !== undefined) {
      const submitId = opts.submitId
      if (typeof submitId !== 'string' || submitId.length === 0 || submitId.length > 64) {
        return { ok: false, error: 'invalid submitId' }
      }
      const claim = claimSubmitId(this.sql.bind(this), submitId)
      if (!claim.ok) {
        return { ok: false, error: claim.error }
      }
      if (claim.duplicate) {
        return { ok: true }
      }
    }

    // GH#38 P1.2: validate optional `createdAt` (ISO 8601). When supplied,
    // the server adopts it verbatim as the row's createdAt so optimistic
    // loopback reconciliation via TanStack DB deepEquals sees identical
    // rows. Invalid ISO → 400-ish error from the RPC.
    if (opts?.createdAt !== undefined) {
      if (typeof opts.createdAt !== 'string' || Number.isNaN(new Date(opts.createdAt).getTime())) {
        return { ok: false, error: 'invalid createdAt' }
      }
    }

    const hasLiveRunner = Boolean(this.getGatewayConnectionId())

    // Auto-heal a stuck status='running' / 'waiting_gate' with no attached
    // runner: this happens when maybeRecoverAfterGatewayDrop's grace path
    // loses its setTimeout to hibernation and the watchdog alarm hasn't yet
    // run recovery. Without this, the next user turn hits the isResumable
    // gate below and returns "Cannot send message: status is 'running'" —
    // the session is permanently wedged until manual intervention.
    if (
      !hasLiveRunner &&
      (this.state.status === 'running' || this.state.status === 'waiting_gate')
    ) {
      console.warn(
        `[SessionDO:${this.ctx.id}] sendMessage: auto-healing stuck status='${this.state.status}' with no runner — running recovery inline`,
      )
      await this.recoverFromDroppedConnection()
      // recovery flipped status to 'idle' and preserved sdk_session_id;
      // fall through to the resumable path below.
    }

    const { status } = this.state
    // A session-runner stays alive through `type=result` and blocks waiting on
    // the next stream-input (see claude-runner.ts multi-turn loop). Route by
    // connection liveness, not by DO status: if the gateway-role WS is still
    // attached, reuse that runner — dialling a fresh one would collide with
    // the existing sdk_session_id inside session-runner's hasLiveResume guard
    // and nothing would happen from the user's perspective.
    const isResumable = !hasLiveRunner && status === 'idle' && this.state.sdk_session_id

    if (!hasLiveRunner && !isResumable) {
      return { ok: false, error: `Cannot send message: status is '${status}'` }
    }

    // GH#8 preflight: if we're about to trigger a gateway dial but the
    // gateway-contract env vars are missing, fail loudly BEFORE persisting
    // the user message. Otherwise the message lands in history, the
    // triggerGatewayDial bail at line ~315 flips status to idle, and the
    // user perceives a "silent no-op" with nothing in the transcript to
    // explain it. See planning/research/2026-04-18-verify-infra-issue-8.md.
    if (!hasLiveRunner && isResumable) {
      if (!this.env.CC_GATEWAY_URL || !this.env.WORKER_PUBLIC_URL) {
        console.error(
          `[SessionDO:${this.ctx.id}] sendMessage preflight: CC_GATEWAY_URL=${Boolean(this.env.CC_GATEWAY_URL)} WORKER_PUBLIC_URL=${Boolean(this.env.WORKER_PUBLIC_URL)} — gateway not configured`,
        )
        return {
          ok: false,
          error:
            'Gateway not configured for this worker (missing CC_GATEWAY_URL or WORKER_PUBLIC_URL)',
        }
      }
    }

    // If we're about to take the resume path, preflight for an orphan
    // runner that would hijack the sdk_session_id. If found, auto-fork to a
    // fresh SDK session so the user doesn't see silent failure.
    if (!hasLiveRunner && isResumable) {
      const sdk = this.state.sdk_session_id ?? ''
      const gatewayUrl = this.env.CC_GATEWAY_URL
      if (gatewayUrl && sdk) {
        try {
          const sessions = await listSessions(gatewayUrl, this.env.CC_GATEWAY_SECRET)
          const orphan = sessions.find((s) => s.sdk_session_id === sdk && s.state === 'running')
          if (orphan) {
            console.warn(
              `[SessionDO:${this.ctx.id}] sendMessage: orphan runner ${orphan.session_id} holds sdk_session_id ${sdk} — auto-forking with transcript`,
            )
            return this.forkWithHistory(content)
          }
        } catch (err) {
          // Non-fatal: fall through to the dial attempt. If it then collides
          // the runner will crash and the exit file makes it visible.
          console.warn(`[SessionDO:${this.ctx.id}] sendMessage preflight failed:`, err)
        }
      }
    }

    // GH#38 P1.2: duplicate-clientId idempotency. If a client retries the
    // POST after a network hiccup (same `clientId` → same `userMsgId`),
    // the row may already be persisted. Check first and short-circuit —
    // do NOT overwrite, re-broadcast, or re-invoke the SDK.
    const candidateId = opts?.client_message_id ?? `usr-${this.turnCounter + 1}`
    if (opts?.client_message_id) {
      try {
        // Same SDK-owned `assistant_messages` table the Session class writes
        // to. `session_id` is always the literal empty string in our setup
        // because `Session.create(this)` is called without `.forSession(id)`
        // — see comment in the GET /messages handler for the full rationale.
        const existing = this.sql<{ id: string }>`
          SELECT id FROM assistant_messages
          WHERE id = ${candidateId} AND session_id = ''
          LIMIT 1
        `
        if ([...existing].length > 0) {
          return { ok: true, duplicate: true, id: candidateId }
        }
      } catch (err) {
        // Defensive: if the lookup fails (table absent pre-first-append),
        // fall through and let appendMessage proceed normally.
        console.warn(
          `[SessionDO:${this.ctx.id}] sendMessage: duplicate-id precheck failed (proceeding):`,
          err,
        )
      }
    }

    // Persist user message (only after orphan preflight so we don't have to
    // roll it back on the auto-fork branch — forkWithHistory appends itself).
    this.turnCounter++
    const canonicalTurnId = `usr-${this.turnCounter}`
    const userMsgId = opts?.client_message_id ?? canonicalTurnId
    const userMsg: SessionMessage & { canonical_turn_id?: string } = {
      id: userMsgId,
      role: 'user',
      parts: [...contentToParts(content), this.buildAwaitingPart('first_token')],
      createdAt: opts?.createdAt ? new Date(opts.createdAt) : new Date(),
      canonical_turn_id: canonicalTurnId,
    }
    try {
      await this.safeAppendMessage(userMsg)
      this.persistTurnState()
      // GH#38 P1.5 / B10: emit messages + branchInfo siblings back-to-back
      // on the same DO turn. broadcastBranchInfo no-ops when the new turn
      // didn't introduce a sibling (most sendMessage calls extend the leaf).
      this.broadcastMessages([userMsg as unknown as WireSessionMessage])
      const siblingRow = this.computeBranchInfoForUserTurn(userMsg)
      if (siblingRow) {
        this.broadcastBranchInfo([siblingRow])
      }
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to persist user message:`, err)
    }
    // Spec #80 B1: flip status to 'pending' so UI renders the awaiting
    // bubble while we wait on the first runner event. Runs before the
    // gateway-dispatch branches below so the 'pending' → 'running'
    // transition is monotonic on the happy path.
    this.updateState({ status: 'pending', error: null })
    void this.syncStatusToD1(new Date().toISOString())

    if (hasLiveRunner) {
      // Promote state back to running so the UI reflects the new turn.
      if (status !== 'running' && status !== 'waiting_gate') {
        this.updateState({ status: 'running', error: null })
        this.syncStatusToD1(new Date().toISOString())
      }
      this.sendToGateway({
        type: 'stream-input',
        session_id: this.state.session_id ?? '',
        message: { role: 'user', content },
        ...(opts?.client_message_id ? { client_message_id: opts.client_message_id } : {}),
      })
    } else if (isResumable) {
      this.updateState({ status: 'running', error: null })
      this.syncStatusToD1(new Date().toISOString())
      void this.triggerGatewayDial({
        type: 'resume',
        project: this.state.project,
        prompt: content,
        sdk_session_id: this.state.sdk_session_id ?? '',
      })
    }

    return { ok: true, id: userMsgId }
  }

  /**
   * Spawn a fresh SDK session (new sdk_session_id) seeded with a transcript
   * of the prior conversation. Feels like a resume from the user's POV but
   * sidesteps SDK `resume` entirely — useful when the prior sdk_session_id
   * is orphaned by a stuck session-runner, unresumable, or we just want a
   * clean context window without losing the thread.
   */
  @callable()
  async forkWithHistory(
    content: string | ContentBlock[],
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.state.project) {
      return { ok: false, error: 'Session has no project — cannot fork.' }
    }

    // Build a compact transcript from local history (safe to read even when
    // the DO has lost WS contact with its session-runner).
    const history = this.session.getHistory()
    const transcript = history
      .map((m) => {
        const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role
        const text = m.parts
          .map((p) => {
            if (p.type === 'text') return p.text ?? ''
            if (p.type === 'reasoning') return `[thinking] ${p.text ?? ''}`
            if (typeof p.type === 'string' && p.type.startsWith('tool-')) {
              const name = (p as { toolName?: string }).toolName ?? p.type.slice(5)
              return `[used tool: ${name}]`
            }
            return ''
          })
          .filter(Boolean)
          .join('\n')
        return text ? `${role}: ${text}` : ''
      })
      .filter(Boolean)
      .join('\n\n')

    const nextText =
      typeof content === 'string'
        ? content
        : content
            .map((b) => {
              const bl = b as { type?: string; text?: string }
              return bl.type === 'text' ? (bl.text ?? '') : ''
            })
            .filter(Boolean)
            .join('\n')

    const forkedPrompt = transcript
      ? `<prior_conversation>\n${transcript}\n</prior_conversation>\n\nContinuing the conversation above. New user message follows.\n\n${nextText}`
      : nextText

    // Persist the user's new message in local history exactly as sendMessage
    // would, so the UI reflects the turn boundary. We do NOT persist the
    // transcript prefix — that's only for the SDK's fresh context.
    this.turnCounter++
    const userMsgId = `usr-${this.turnCounter}`
    const userMsg: SessionMessage & { canonical_turn_id?: string } = {
      id: userMsgId,
      role: 'user',
      parts: [...contentToParts(content), this.buildAwaitingPart('first_token')],
      createdAt: new Date(),
      canonical_turn_id: userMsgId,
    }
    try {
      await this.safeAppendMessage(userMsg)
      this.persistTurnState()
      // GH#38 P1.5 / B10: emit messages + branchInfo siblings back-to-back.
      this.broadcastMessages([userMsg as unknown as WireSessionMessage])
      const siblingRow = this.computeBranchInfoForUserTurn(userMsg)
      if (siblingRow) {
        this.broadcastBranchInfo([siblingRow])
      }
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] forkWithHistory: persist user msg failed:`, err)
    }

    // Spec #80 B3: drop the old sdk_session_id so the new runner gets a
    // brand-new one (guarantees no hasLiveResume collision with any
    // orphan) and flip status to 'pending' while we wait for the dial.
    this.updateState({
      status: 'pending',
      error: null,
      sdk_session_id: null,
    })
    void this.syncStatusToD1(new Date().toISOString())

    void this.triggerGatewayDial({
      type: 'execute',
      project: this.state.project,
      prompt: forkedPrompt,
    })

    return { ok: true }
  }

  @callable()
  async interrupt(): Promise<{ ok: boolean; error?: string }> {
    if (this.state.status !== 'running' && this.state.status !== 'waiting_gate') {
      return { ok: false, error: `Cannot interrupt: status is '${this.state.status}'` }
    }

    // Release ALL pending gate parts. The UI may be rendering a
    // GateResolver for any tool_call_id with approval-requested state.
    // Flipping every approval-requested gate part to 'output-denied'
    // guarantees the UI clears its GateResolver(s) when the user hits
    // interrupt. The subsequent `interrupt` command to the runner aborts
    // the SDK's in-flight canUseTool promise — no per-gate cancel
    // command exists, so we rely on the SDK interrupt to release the
    // pending answer/permission wait.
    const history = this.session.getHistory()
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i]
      const hasPendingGate = msg.parts.some(
        (p) =>
          p.state === 'approval-requested' &&
          (p.type === 'tool-ask_user' || p.type === 'tool-permission'),
      )
      if (!hasPendingGate) continue
      const updatedParts = msg.parts.map((p) =>
        p.state === 'approval-requested' &&
        (p.type === 'tool-ask_user' || p.type === 'tool-permission')
          ? { ...p, state: 'output-denied' as const, output: 'Interrupted' }
          : p,
      )
      const updatedMsg: SessionMessage = { ...msg, parts: updatedParts }
      try {
        this.safeUpdateMessage(updatedMsg)
        this.broadcastMessage(updatedMsg)
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] Failed to mark gate interrupted:`, err)
      }
    }

    // Flip status back to running so the watchdog and UI agree.
    if (this.state.status === 'waiting_gate') {
      this.updateState({ status: 'running' })
    }

    this.sendToGateway({ type: 'interrupt', session_id: this.state.session_id ?? '' })
    return { ok: true }
  }

  /**
   * P3 B4: cached-or-fresh context usage reader.
   *
   * Semantics:
   * - Fresh cache hit (<5s old) → return cached value, `isCached: true`.
   * - Stale-or-missing + gateway connected → single-flight probe with 3s
   *   timeout; on success UPDATE the cache and return `isCached: false`.
   * - No gateway connection → return stale cache (or null) with
   *   `isCached: true`.
   * - Probe timeout or error → fall through to stale cache / null.
   *
   * Retained as `@callable()` so the existing client-side
   * `connection.call('getContextUsage', [])` trigger continues to work.
   * Also invoked via HTTP by `onRequest`'s `GET /context-usage` route
   * (backing `/api/sessions/:id/context-usage`).
   */
  @callable()
  async getContextUsage(): Promise<{
    contextUsage: ContextUsage | null
    fetchedAt: string
    isCached: boolean
  }> {
    const rows = this.sql<{
      context_usage_json: string | null
      context_usage_cached_at: number | null
    }>`SELECT context_usage_json, context_usage_cached_at FROM session_meta WHERE id = 1`
    const row = rows[0]
    const cached =
      row?.context_usage_json && row.context_usage_cached_at != null
        ? {
            value: JSON.parse(row.context_usage_json) as ContextUsage,
            cachedAt: row.context_usage_cached_at,
          }
        : null
    const now = Date.now()
    if (cached && now - cached.cachedAt < 5_000) {
      return {
        contextUsage: cached.value,
        fetchedAt: new Date(cached.cachedAt).toISOString(),
        isCached: true,
      }
    }
    if (!this.getGatewayConnectionId()) {
      return {
        contextUsage: cached?.value ?? null,
        fetchedAt: cached ? new Date(cached.cachedAt).toISOString() : new Date().toISOString(),
        isCached: true,
      }
    }
    if (!this.contextUsageProbeInFlight) {
      this.contextUsageProbeInFlight = this.probeContextUsageWithTimeout().finally(() => {
        this.contextUsageProbeInFlight = null
      })
    }
    try {
      const value = await this.contextUsageProbeInFlight
      const cachedAt = Date.now()
      this.sql`UPDATE session_meta
        SET context_usage_json = ${JSON.stringify(value)},
            context_usage_cached_at = ${cachedAt},
            updated_at = ${cachedAt}
        WHERE id = 1`
      return {
        contextUsage: value,
        fetchedAt: new Date(cachedAt).toISOString(),
        isCached: false,
      }
    } catch {
      return {
        contextUsage: cached?.value ?? null,
        fetchedAt: cached ? new Date(cached.cachedAt).toISOString() : new Date().toISOString(),
        isCached: true,
      }
    }
  }

  /**
   * P3 B4: dispatch a `get-context-usage` GatewayCommand and await the
   * matched `context_usage` gateway_event. 3s timeout — if the runner is
   * unresponsive we reject and the caller falls back to stale / null rather
   * than blocking the Worker up to its CPU limit.
   */
  private probeContextUsageWithTimeout(): Promise<ContextUsage | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this resolver so a late gateway reply doesn't leak into
        // the next probe's resolver slot.
        const idx = this.contextUsageResolvers.findIndex((r) => r.resolve === innerResolve)
        if (idx >= 0) this.contextUsageResolvers.splice(idx, 1)
        reject(new Error('probe_timeout'))
      }, 3_000)
      const innerResolve = (v: ContextUsage | null) => {
        clearTimeout(timer)
        resolve(v)
      }
      const innerReject = (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      }
      this.contextUsageResolvers.push({ resolve: innerResolve, reject: innerReject })
      this.sendToGateway({ type: 'get-context-usage', session_id: this.state.session_id ?? '' })
    })
  }

  /**
   * P3 B5: kataState reader backed by the D1 `agent_sessions` mirror (source
   * of truth — written by `syncKataToD1` on every `kata_state` event). Also
   * consults the DO-local `kv.kata_state` blob for the richer full shape;
   * falls back to a minimal shape synthesized from the D1 columns if the kv
   * blob is absent (e.g. after cold-start before the first kata_state event).
   *
   * Returns `null` when the session has no kata binding. The route returns a
   * value even when the runner is dead because the D1 mirror survives.
   */
  async getKataState(): Promise<{ kataState: KataSessionState | null; fetchedAt: string }> {
    const sessionId = this.name
    try {
      const rows = await this.d1
        .select({
          kataMode: agentSessions.kataMode,
          kataIssue: agentSessions.kataIssue,
          kataPhase: agentSessions.kataPhase,
        })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1)
      const row = rows[0]
      if (!row || (row.kataMode == null && row.kataIssue == null && row.kataPhase == null)) {
        return { kataState: null, fetchedAt: new Date().toISOString() }
      }
      // Read the full kata_state blob from the kv table for richer fields if present.
      const kvRows = this.sql<{ value: string }>`SELECT value FROM kv WHERE key = 'kata_state'`
      const kvKata = kvRows[0]?.value ? (JSON.parse(kvRows[0].value) as KataSessionState) : null
      if (kvKata) {
        return { kataState: kvKata, fetchedAt: new Date().toISOString() }
      }
      // Fallback: synthesize a minimal KataSessionState from D1 columns.
      const minimal: KataSessionState = {
        sessionId,
        workflowId: null,
        issueNumber: row.kataIssue ?? null,
        sessionType: null,
        currentMode: row.kataMode ?? null,
        currentPhase: row.kataPhase ?? null,
        completedPhases: [],
        template: null,
        phases: [],
        modeHistory: [],
        modeState: {},
        updatedAt: new Date().toISOString(),
        beadsCreated: [],
        editedFiles: [],
      }
      return { kataState: minimal, fetchedAt: new Date().toISOString() }
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] getKataState failed:`, err)
      return { kataState: null, fetchedAt: new Date().toISOString() }
    }
  }

  @callable()
  async rewind(messageId: string): Promise<{ ok: boolean; error?: string }> {
    this.sendToGateway({
      type: 'rewind',
      session_id: this.state.session_id ?? '',
      message_id: messageId,
    })
    // DO-authored snapshot (B2): broadcast the trimmed history so all clients
    // converge on the post-rewind view without round-tripping through gateway.
    try {
      const history = this.session.getHistory()
      const idx = history.findIndex((m) => m.id === messageId)
      const trimmed = idx >= 0 ? history.slice(0, idx + 1) : history
      // GH#38 P1.4: emit SyncedCollectionFrame on the new messages wire.
      // staleIds = rows present in current default leaf but NOT in trimmed.
      const { ops } = deriveSnapshotOps<WireSessionMessage>({
        oldLeaf: history as unknown as WireSessionMessage[],
        newLeaf: trimmed as unknown as WireSessionMessage[],
      })
      for (const chunk of chunkOps(ops)) {
        this.broadcastMessages({ ops: chunk })
      }
      // GH#38 P1.5 / B15: emit sibling branchInfo frame on the same DO
      // turn. B10: React 18 auto-batches both deltas into a single commit.
      this.broadcastBranchInfo(this.computeBranchInfo(trimmed))
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to broadcast rewind snapshot:`, err)
    }
    return { ok: true }
  }

  @callable()
  async getMessages(opts?: {
    offset?: number
    limit?: number
    session_hint?: string
    leafId?: string
  }): Promise<{ ok: true }> {
    // GH#57: hydration-only RPC. Message sync moved to the cursor-aware
    // `subscribe:messages` WS frame handled in `onMessage`, which is
    // bounded and doesn't call `getHistory()`. This RPC only runs the
    // discovered-session bootstrap + gateway transcript catch-up side
    // effects; the return value is intentionally opaque — callers should
    // not depend on it for history.
    //
    // Self-initialize from D1 for discovered sessions (#7 p6). The cron in
    // src/api/scheduled.ts UPSERTs gateway-discovered rows into agent_sessions
    // every 5 minutes; this just rehydrates a cold DO from that row when the
    // browser hits a session whose DO has no in-memory state yet.
    if (!this.state.sdk_session_id && opts?.session_hint) {
      try {
        const rows = await this.d1
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.id, opts.session_hint))
          .limit(1)
        const row = rows[0]
        if (row?.sdkSessionId) {
          this.updateState({
            sdk_session_id: row.sdkSessionId,
            project: row.project ?? '',
            session_id: row.id,
            summary: row.summary ?? null,
            started_at: row.createdAt || this.state.created_at || new Date().toISOString(),
            created_at: row.createdAt || this.state.created_at || new Date().toISOString(),
          })
        }
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] Failed to init from D1:`, err)
      }
    }

    // Hydrate from VPS gateway — only for discovered sessions with empty
    // local history (cold DO that has never received live events). Sessions
    // that already have messages don't need re-hydration — the cursor-aware
    // `subscribe:messages` replay fills any gap. Running hydrateFromGateway
    // unconditionally was the root cause of idle-reconnect duplicate replay:
    // the merge path calls safeUpdateMessage on existing rows, which bumps
    // modified_at to now(), making them appear "newer than cursor" on the
    // immediately-following subscribe replay. See GH#78 addendum B.
    if (this.state.sdk_session_id && this.state.project && this.session.getPathLength() === 0) {
      await this.hydrateFromGateway()
    }

    return { ok: true }
  }

  @callable()
  async resubmitMessage(
    originalMessageId: string,
    newContent: string,
  ): Promise<{ ok: boolean; leafId?: string; error?: string }> {
    // 1. If streaming in progress, abort first
    if (this.currentTurnMessageId) {
      this.sendToGateway({ type: 'abort', session_id: this.state.session_id ?? '' })
      // Finalize orphaned streaming parts
      const existing = this.session.getMessage(this.currentTurnMessageId)
      if (existing) {
        const finalizedParts = finalizeStreamingParts(existing.parts)
        this.safeUpdateMessage({ ...existing, parts: finalizedParts })
      }
      this.currentTurnMessageId = null
    }

    // 2. Find the parent of the original message
    const originalMsg = this.session.getMessage(originalMessageId)
    if (!originalMsg) {
      return { ok: false, error: 'Original message not found' }
    }

    // Get history to find parent: the message before originalMessageId in the path
    const history = this.session.getHistory(originalMessageId)
    const origIdx = history.findIndex((m) => m.id === originalMessageId)
    const parentId = origIdx > 0 ? history[origIdx - 1].id : null

    // 3. Create new user message as sibling branch
    this.turnCounter++
    const newUserMsgId = `usr-${this.turnCounter}`
    const newUserMsg: SessionMessage & { canonical_turn_id?: string } = {
      id: newUserMsgId,
      role: 'user',
      parts: [{ type: 'text', text: newContent }, this.buildAwaitingPart('first_token')],
      createdAt: new Date(),
      canonical_turn_id: newUserMsgId,
    }

    try {
      this.safeAppendMessage(newUserMsg, parentId)
      this.persistTurnState()
      this.broadcastMessage(newUserMsg)
      // DO-authored snapshot (B2): broadcast the branch view so all clients
      // realign onto the new leaf. getHistory(leafId) returns the path ending
      // at newUserMsg.id.
      const oldLeafHistory = this.session.getHistory(originalMessageId)
      const resubmitHistory = this.session.getHistory(newUserMsg.id)
      // GH#38 P1.4: emit SyncedCollectionFrame on the new messages wire.
      // staleIds = rows on the oldLeaf path (ending at originalMessageId)
      // but NOT on the newLeaf path — typically [originalMessageId] since
      // the sibling branches share a prefix up to `parentId`.
      const { ops } = deriveSnapshotOps<WireSessionMessage>({
        oldLeaf: oldLeafHistory as unknown as WireSessionMessage[],
        newLeaf: resubmitHistory as unknown as WireSessionMessage[],
      })
      for (const chunk of chunkOps(ops)) {
        this.broadcastMessages({ ops: chunk })
      }
      // GH#38 P1.5 / B15: emit sibling branchInfo frame on the same DO turn.
      this.broadcastBranchInfo(this.computeBranchInfo(resubmitHistory))
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to create branch:`, err)
      return { ok: false, error: 'Failed to create branch' }
    }

    // 4. Send to gateway for execution
    // Spec #80 B4: flip status to 'pending' while we wait for the dial.
    this.updateState({ status: 'pending', error: null })
    void this.syncStatusToD1(new Date().toISOString())
    void this.triggerGatewayDial({
      type: 'resume',
      project: this.state.project,
      prompt: newContent,
      sdk_session_id: this.state.sdk_session_id ?? '',
    })

    return { ok: true, leafId: newUserMsgId }
  }

  @callable()
  async getBranchHistory(
    leafId: string,
  ): Promise<{ ok: true } | { ok: false; error: 'unknown_leaf' | 'not_on_branch' }> {
    const history = this.session.getHistory()
    const found = history.find((m) => m.id === leafId)
    if (!found) return { ok: false, error: 'unknown_leaf' }
    if (found.role !== 'user') return { ok: false, error: 'not_on_branch' }
    // Known limitation: scope branch-navigate snapshot to the requesting
    // client once `@callable` surfaces the caller connection id. The agents
    // SDK (v0.11) dispatches RPCs via `super.onMessage` with no public
    // callback for caller identity, so we broadcast to all browser
    // connections. Harmless over-delivery — matches B1 correctness and the
    // client's per-session `lastSeq` watermark still drops stale frames.
    const messages = this.session.getHistory(leafId) ?? history
    // GH#38 P1.4: emit SyncedCollectionFrame on the new messages wire.
    // staleIds = rows on the current default leaf but NOT on the target
    // branch's leaf. `history` here is the default-leaf view (from above).
    const { ops } = deriveSnapshotOps<WireSessionMessage>({
      oldLeaf: history as unknown as WireSessionMessage[],
      newLeaf: messages as unknown as WireSessionMessage[],
    })
    for (const chunk of chunkOps(ops)) {
      this.broadcastMessages({ ops: chunk })
    }
    // GH#38 P1.5 / B15: emit sibling branchInfo frame on the same DO turn.
    this.broadcastBranchInfo(this.computeBranchInfo(messages))
    return { ok: true }
  }

  @callable()
  async requestSnapshot(
    opts: { targetClientId?: string } = {},
  ): Promise<{ ok: true } | { ok: false; error: 'session_empty' }> {
    const messages = this.session.getHistory()
    if (messages.length === 0) return { ok: false, error: 'session_empty' }
    // GH#75: client passes its PartySocket `connection.id` as
    // `targetClientId`. When present, forward to the targeted paths so
    // both the messages frame and the sibling branchInfo frame carry
    // `targeted: true` and land only on the requesting connection —
    // non-recipients stay aligned with the shared seq stream.
    // Trust boundary: a spoofed targetClientId can only redirect this
    // session's own history to a conn already a member of this DO's
    // connection set (same session, same user's client). No cross-user
    // data exfiltration path; worst case is a self-DoS.
    // Backward compat: caller may omit `opts` entirely (or pass
    // `undefined`), in which case we fall back to the pre-GH#75
    // broadcast behavior and the client's per-session `lastSeq`
    // watermark drops stale frames.
    // GH#38 P1.4: emit SyncedCollectionFrame on the new messages wire.
    // staleIds = [] — a client-requested resync has no known prior state
    // from the server's perspective; fresh is the full history.
    const { ops } = deriveSnapshotOps<WireSessionMessage>({
      oldLeaf: [],
      newLeaf: messages as unknown as WireSessionMessage[],
    })
    for (const chunk of chunkOps(ops)) {
      this.broadcastMessages({ ops: chunk }, opts)
    }
    // GH#38 P1.5 / B15: emit sibling branchInfo frame on the same DO turn.
    this.broadcastBranchInfo(this.computeBranchInfo(messages), opts)
    return { ok: true }
  }

  @callable()
  async getStatus() {
    return {
      state: this.state,
      recent_events: [],
    }
  }

  @callable()
  async getKataStatus() {
    const rows = this.sql<{ value: string }>`SELECT value FROM kv WHERE key = 'kata_state'`
    const arr = [...rows]
    if (arr.length === 0) return null
    try {
      return JSON.parse(arr[0].value)
    } catch {
      return null
    }
  }

  // ── Gateway Event Handling ─────────────────────────────────────

  handleGatewayEvent(event: GatewayEvent) {
    switch (event.type) {
      // GH#75 B4: relay BufferedChannel gap sentinel from the runner →
      // DO → client. The runner stamps `{type:'gap', dropped_count,
      // from_seq, to_seq}` on its WS when the pre-reattach buffer
      // overflowed; on the client we treat this as a synthetic gap
      // trigger and fire requestSnapshot. We don't try to reconcile the
      // sentinel's runner-seq range — runner.seq and DO.messageSeq are
      // different namespaces and the snapshot is the only safe
      // rehydration.
      case 'gap':
        this.broadcastToClients(
          JSON.stringify({
            type: 'gap',
            dropped_count: (event as { dropped_count?: number }).dropped_count ?? 0,
            from_seq: (event as { from_seq?: number }).from_seq ?? 0,
            to_seq: (event as { to_seq?: number }).to_seq ?? 0,
          }),
        )
        break

      case 'session.init':
        this.updateState({ sdk_session_id: event.sdk_session_id, model: event.model })
        // Sync sdk_session_id to D1 so discovery won't create a duplicate row.
        if (event.sdk_session_id) {
          this.syncSdkSessionIdToD1(event.sdk_session_id, new Date().toISOString())
        }
        break

      case 'partial_assistant': {
        this.clearAwaitingResponse()
        const parts = partialAssistantToParts(event.content)
        const msgId = `msg-${this.turnCounter}`

        if (!this.currentTurnMessageId) {
          this.currentTurnMessageId = msgId

          // Check if message already exists (multi-response turn: assistant → tool → assistant)
          const existing = this.session.getMessage(msgId)
          if (existing) {
            // Merge streaming text / reasoning into existing parts (preserving tool results)
            const updatedParts = [...existing.parts]
            for (const newPart of parts) {
              if (newPart.type === 'text' || newPart.type === 'reasoning') {
                updatedParts.push(newPart)
              }
            }
            const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
            try {
              this.safeUpdateMessage(updatedMsg)
              this.broadcastMessage(updatedMsg)
            } catch (err) {
              console.error('[session-do] event persist failed', err)
            }
          } else {
            // First partial of this turn — append new message. Parent defaults
            // to latestLeafRow() (the user row just persisted in sendMessage),
            // whose id may be `usr-N` OR `usr-client-<uuid>` depending on
            // whether the client supplied a `client_message_id` (GH#14 B6).
            // Passing an explicit `usr-${turnCounter}` used to silently land
            // parent_id=NULL when the user row was keyed on the client id —
            // orphaning every assistant and collapsing getHistory() to one row.
            const msg: SessionMessage = {
              id: msgId,
              role: 'assistant',
              parts,
              createdAt: new Date(),
            }
            try {
              this.safeAppendMessage(msg)
              this.persistTurnState()
              this.broadcastMessage(msg)
            } catch (err) {
              console.error('[session-do] event persist failed', err)
            }
          }
        } else {
          // Subsequent partial — update existing message with accumulated text
          const existing = this.session.getMessage(this.currentTurnMessageId)
          if (existing) {
            // Merge streaming parts: find an existing streaming text / reasoning
            // part of the same kind and append the delta. This drives live
            // token-by-token rendering for both the assistant text and the
            // extended-thinking trace.
            const updatedParts = [...existing.parts]
            for (const newPart of parts) {
              if (newPart.type === 'text') {
                const existingIdx = updatedParts.findIndex(
                  (p) => p.type === 'text' && p.state === 'streaming',
                )
                if (existingIdx !== -1) {
                  updatedParts[existingIdx] = {
                    ...updatedParts[existingIdx],
                    text: (updatedParts[existingIdx].text ?? '') + (newPart.text ?? ''),
                  }
                } else {
                  updatedParts.push(newPart)
                }
              } else if (newPart.type === 'reasoning') {
                const existingIdx = updatedParts.findIndex(
                  (p) => p.type === 'reasoning' && p.state === 'streaming',
                )
                if (existingIdx !== -1) {
                  updatedParts[existingIdx] = {
                    ...updatedParts[existingIdx],
                    text: (updatedParts[existingIdx].text ?? '') + (newPart.text ?? ''),
                  }
                } else {
                  updatedParts.push(newPart)
                }
              }
            }
            const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
            try {
              this.safeUpdateMessage(updatedMsg)
              this.broadcastMessage(updatedMsg)
            } catch (err) {
              console.error('[session-do] event persist failed', err)
            }
          }
        }
        break
      }

      case 'assistant': {
        this.clearAwaitingResponse()
        // Final assistant message — finalize streaming parts with final content
        const newParts = assistantContentToParts(event.content as unknown[])
        const msgId = this.currentTurnMessageId ?? `msg-${this.turnCounter}`

        // Merge finalizes any streaming text/reasoning parts (preserving the
        // text accumulated from partial_assistant deltas) and appends newParts
        // while avoiding duplicating text/reasoning that already streamed — the
        // SDK's final assistant event may or may not re-emit thinking blocks,
        // so the authoritative copy of extended-thinking traces is the streamed
        // one. See mergeFinalAssistantParts + its regression-guard tests.
        const existing = this.session.getMessage(msgId)
        const mergedParts = mergeFinalAssistantParts(existing?.parts, newParts)

        const msg: SessionMessage = {
          id: msgId,
          role: 'assistant',
          parts: mergedParts,
          createdAt: existing?.createdAt ?? new Date(),
        }
        try {
          if (existing) {
            this.safeUpdateMessage(msg)
          } else {
            // No partial fired first — append from scratch. Parent defaults to
            // latestLeafRow(), which is the user row this assistant replies
            // to. See partial_assistant branch for the full rationale.
            this.safeAppendMessage(msg)
          }
          this.currentTurnMessageId = null
          this.persistTurnState()
          this.broadcastMessage(msg)
        } catch (err) {
          console.error('[session-do] event persist failed', err)
        }
        this.updateState({ num_turns: this.state.num_turns + 1 })
        break
      }

      case 'tool_result': {
        this.clearAwaitingResponse()
        // Update the current assistant message's tool parts with results
        const currentMsgId = this.currentTurnMessageId ?? `msg-${this.turnCounter}`
        const existing = this.session.getMessage(currentMsgId)
        if (existing) {
          const updatedParts = applyToolResult(existing.parts, event)
          const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
          try {
            this.safeUpdateMessage(updatedMsg)
            this.broadcastMessage(updatedMsg)
          } catch (err) {
            console.error('[session-do] event persist failed', err)
          }
        }
        break
      }

      case 'ask_user': {
        this.clearAwaitingResponse()
        // No part-type / state promotion here. The client renders a
        // GateResolver directly off the SDK-native
        // `tool-AskUserQuestion` / `input-available` shape already in the
        // assistant message, so flipping to `tool-ask_user` /
        // `approval-requested` would be a redundant second write to the
        // same row — and produced a race where a fast user's resolveGate
        // RPC beat this event to the DO, resolveGate advanced state to
        // `output-available`, then this handler regressed it back to
        // `approval-requested` and left the UI stuck. The part's own
        // state is the single writer now; resolveGate → tool_result
        // advances it monotonically.

        // Race guard: if resolveGate has already advanced the matching
        // part to a terminal state, announcing the gate now would leave
        // status=waiting_gate dangling + fire a push for a gate that's
        // already closed. Check the part state directly.
        const alreadyResolved = this.session
          .getHistory()
          .some((m) =>
            m.parts.some(
              (p) =>
                p.toolCallId === event.tool_call_id &&
                (p.state === 'output-available' ||
                  p.state === 'output-error' ||
                  p.state === 'output-denied' ||
                  p.state === 'approval-given' ||
                  p.state === 'approval-denied'),
            ),
          )
        if (alreadyResolved) break

        // Status flip + push notification are still load-bearing: UI
        // status indicators and notifications need to distinguish
        // "running" from "blocked on user answer." (#76 P3: gate scalar
        // removed — messages are the sole gate source.)
        this.updateState({ status: 'waiting_gate' })
        this.syncStatusToD1(new Date().toISOString())
        this.ctx.waitUntil(
          this.dispatchPush(
            {
              title: this.state.project || 'Duraclaw',
              body: `Asking: ${((event.questions?.[0] as Record<string, unknown>)?.question as string)?.slice(0, 100) || 'Question'}`,
              url: `/?session=${this.state.session_id}`,
              tag: `session-${this.state.session_id}`,
              sessionId: this.state.session_id ?? '',
              actions: [{ action: 'open', title: 'Open' }],
            },
            'blocked',
          ),
        )
        break
      }

      case 'permission_request': {
        this.clearAwaitingResponse()
        // Same strategy as ask_user: promote the existing tool part created
        // by the assistant event rather than appending a duplicate.
        const permPromoteResult = this.promoteToolPartToGate(
          event.tool_call_id,
          'tool-permission',
          'permission',
          { tool_name: event.tool_name, tool_call_id: event.tool_call_id },
        )

        // Same race guard as ask_user (see above).
        if (permPromoteResult === 'already-resolved') {
          break
        }

        // Status flip + D1 sync + action token + push are still
        // load-bearing. (#76 P3: gate scalar removed.)
        this.updateState({ status: 'waiting_gate' })
        this.syncStatusToD1(new Date().toISOString())
        this.ctx.waitUntil(
          (async () => {
            try {
              const actionToken = await generateActionToken(
                this.state.session_id ?? '',
                event.tool_call_id,
                this.env.BETTER_AUTH_SECRET,
              )
              await this.dispatchPush(
                {
                  title: this.state.project || 'Duraclaw',
                  body: `Needs permission: ${event.tool_name}`,
                  url: `/?session=${this.state.session_id}`,
                  tag: `session-${this.state.session_id}`,
                  sessionId: this.state.session_id ?? '',
                  actionToken,
                  actions: [
                    { action: 'approve', title: 'Allow' },
                    { action: 'deny', title: 'Deny' },
                  ],
                },
                'blocked',
              )
            } catch (err) {
              console.error(`[SessionDO:${this.ctx.id}] Failed to generate action token:`, err)
            }
          })(),
        )
        break
      }

      case 'file_changed': {
        // Add file_changed data part to current assistant message
        const currentMsgId = this.currentTurnMessageId ?? `msg-${this.turnCounter}`
        const existing = this.session.getMessage(currentMsgId)
        if (existing) {
          const updatedParts: SessionMessagePart[] = [
            ...existing.parts,
            {
              type: 'data-file-changed',
              text: event.path,
              state: event.tool === 'write' ? 'created' : 'modified',
            },
          ]
          const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
          try {
            this.safeUpdateMessage(updatedMsg)
            this.broadcastMessage(updatedMsg)
          } catch (err) {
            console.error(`[SessionDO:${this.ctx.id}] Failed to persist file_changed:`, err)
          }
        }
        break
      }

      case 'result': {
        this.clearAwaitingResponse()
        // GH#75 P1.2 B7 — REORDER GUARD: all per-message broadcast frames
        // for this turn MUST fire before we flip state to `idle` and sync
        // status to D1. Client derived-status folds over messagesCollection
        // (spec #31), so if status flips first the sidebar can resolve to
        // idle while the final assistant frame is still in flight. The
        // `finalizeResultTurn` helper encodes the ordering by construction;
        // do not inline the phases without preserving that invariant.
        const _now = new Date().toISOString()
        finalizeResultTurn({
          broadcastPhase: () => {
            // Finalize orphaned streaming parts
            if (this.currentTurnMessageId) {
              const existing = this.session.getMessage(this.currentTurnMessageId)
              if (existing) {
                const finalizedParts = finalizeStreamingParts(existing.parts)
                this.safeUpdateMessage({ ...existing, parts: finalizedParts })
                this.broadcastMessage({ ...existing, parts: finalizedParts })
              }
              this.currentTurnMessageId = null
              this.persistTurnState()
            }

            // If SDK reported an error result, show it inline as a system message
            if (event.is_error && event.result) {
              this.turnCounter++
              const errorMsgId = `err-${this.turnCounter}`
              const errorMsg: SessionMessage = {
                id: errorMsgId,
                role: 'system',
                parts: [{ type: 'text', text: `⚠ Error: ${event.result}` }],
                createdAt: new Date(),
              }
              this.safeAppendMessage(errorMsg)
              this.broadcastMessage(errorMsg)
            }

            // If the SDK result contains text that isn't already in the last message,
            // append it as a visible assistant message so the final response is shown.
            if (!event.is_error && event.result && typeof event.result === 'string') {
              const lastMsgId = `msg-${this.turnCounter}`
              const lastMsg = this.session.getMessage(lastMsgId)
              const lastHasText = lastMsg?.parts?.some(
                (p) => p.type === 'text' && p.state === 'done' && p.text,
              )
              if (!lastHasText) {
                // The last assistant turn had only tool calls, no final text — add result text
                if (lastMsg) {
                  const updatedParts: SessionMessagePart[] = [
                    ...lastMsg.parts,
                    { type: 'text', text: event.result, state: 'done' },
                  ]
                  const updatedMsg: SessionMessage = { ...lastMsg, parts: updatedParts }
                  this.safeUpdateMessage(updatedMsg)
                  this.broadcastMessage(updatedMsg)
                } else {
                  this.turnCounter++
                  const resultMsgId = `msg-${this.turnCounter}`
                  const resultMsg: SessionMessage = {
                    id: resultMsgId,
                    role: 'assistant',
                    parts: [{ type: 'text', text: event.result, state: 'done' }],
                    createdAt: new Date(),
                  }
                  this.safeAppendMessage(resultMsg)
                  this.broadcastMessage(resultMsg)
                }
              }
            }
          },
          updateStateIdle: () => {
            // PRESERVE all existing side effects — always transition to idle.
            // NOTE: `type=result` is a *turn-complete* signal from the SDK, not a
            // session-complete signal. The session-runner stays alive waiting on
            // stream-input for the next turn (see claude-runner multi-turn loop),
            // so we keep active_callback_token intact — clearing it would block the
            // runner from re-dialling if its WS flaps. The token is cleared only
            // on true terminal transitions (stopped/failed/aborted/crashed).
            this.updateState({
              status: 'idle',
              completed_at: new Date().toISOString(),
              result: event.result,
              duration_ms: (this.state.duration_ms ?? 0) + (event.duration_ms ?? 0),
              total_cost_usd: (this.state.total_cost_usd ?? 0) + (event.total_cost_usd ?? 0),
              num_turns: this.state.num_turns + (event.num_turns ?? 0),
              error: event.is_error ? event.result : null,
              summary: event.sdk_summary ?? this.state.summary,
            })
          },
          syncStatusToD1: () => {
            this.syncStatusToD1(_now)
          },
          syncResultToD1: () => {
            this.syncResultToD1(_now)
          },
        })
        // Spec #37 B9: the legacy per-turn summary WS frame is retired —
        // numTurns / totalCostUsd / durationMs now reach the client via the
        // `agent_sessions` synced-collection delta emitted by syncResultToD1
        // → broadcastSessionRow above.
        // Discovered-session fan-out is now owned by the cron in
        // src/api/scheduled.ts (#7 p6); SessionDO no longer mirrors here.
        if (!event.is_error) {
          this.ctx.waitUntil(
            this.dispatchPush(
              {
                title: this.state.project || 'Duraclaw',
                body: `Completed (${this.state.num_turns} turns, $${(this.state.total_cost_usd ?? 0).toFixed(2)})`,
                url: `/?session=${this.state.session_id}`,
                tag: `session-${this.state.session_id}`,
                sessionId: this.state.session_id ?? '',
                actions: [
                  { action: 'open', title: 'Open' },
                  { action: 'new-session', title: 'New Session' },
                ],
              },
              'completed',
            ),
          )
        } else {
          this.ctx.waitUntil(
            this.dispatchPush(
              {
                title: this.state.project || 'Duraclaw',
                body: `Failed: ${event.result || 'Session failed'}`,
                url: `/?session=${this.state.session_id}`,
                tag: `session-${this.state.session_id}`,
                sessionId: this.state.session_id ?? '',
              },
              'error',
            ),
          )
        }
        break
      }

      case 'stopped': {
        this.clearAwaitingResponse()
        // Finalize orphaned streaming parts
        if (this.currentTurnMessageId) {
          const existing = this.session.getMessage(this.currentTurnMessageId)
          if (existing) {
            const finalizedParts = finalizeStreamingParts(existing.parts)
            this.safeUpdateMessage({ ...existing, parts: finalizedParts })
          }
          this.currentTurnMessageId = null
          this.persistTurnState()
        }

        // PRESERVE existing side effects; clear active_callback_token (terminal).
        this.updateState({
          status: 'idle',
          completed_at: new Date().toISOString(),
          active_callback_token: undefined,
        })
        // Chain auto-advance (spec 16-chain-ux-p1-5 B6 / B7 / B9) must run
        // AFTER syncStatusToD1 flushes — tryAutoAdvance's preconditions query
        // agent_sessions expecting status='idle' + numTurns>0. Racing these
        // two fire-and-forget causes chain stalls with a false "No completed
        // research session" miss.
        void this.syncStatusToD1(new Date().toISOString())
          .then(() => this.maybeAutoAdvanceChain())
          .catch((err) => console.error('[session-do] post-stop chain:', err))
        break
      }

      case 'kata_state': {
        // PRESERVE existing side effects — store in kv and sync to D1.
        try {
          this
            .sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('kata_state', ${JSON.stringify(event.kata_state)})`
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] Failed to persist kata state:`, err)
        }
        {
          const _now = new Date().toISOString()
          this.syncKataAllToD1(event.kata_state, _now)
        }

        // GH#73: persist the runEnded evidence bit whenever it changes.
        // chain auto-advance reads this on the post-stop gate — the runner
        // emits a fresh kata_state frame each time run-end.json appears, so
        // by the time the session lands in 'idle' the bit is already durable.
        {
          const nextRunEnded = event.kata_state?.runEnded === true
          if ((this.state.lastRunEnded ?? false) !== nextRunEnded) {
            this.updateState({ lastRunEnded: nextRunEnded })
          }
        }

        // Chain UX P4: detect mode transitions on chain-linked sessions and
        // reset the runner so each mode gets a fresh SDK session context.
        const ks = event.kata_state
        if (ks?.currentMode && ks.issueNumber != null) {
          const prev = this.state.lastKataMode
          const next = ks.currentMode
          if (prev !== next) {
            this.updateState({ lastKataMode: next })
            // Initial mode observation on a fresh session is NOT a transition —
            // only rotate the runner when we've seen a prior mode. Firing
            // handleModeTransition on the first kata_state would kill the
            // runner that just spawned with the user's typed prompt and
            // replace it with the mode-preamble text.
            if (prev == null) {
              console.log(
                `[SessionDO:${this.ctx.id}] initial mode observed: ${next} — no runner reset`,
              )
            } else if (ks.continueSdk === true) {
              console.log(
                `[SessionDO:${this.ctx.id}] mode change ${prev}→${next} with continueSdk=true, skipping reset`,
              )
            } else {
              // Fire-and-forget — the runner close + respawn involves multi-
              // second awaits that shouldn't block gateway event processing.
              this.handleModeTransition(ks, prev).catch((err) => {
                console.error(`[SessionDO:${this.ctx.id}] handleModeTransition failed:`, err)
              })
            }
          }
        }
        break
      }

      case 'error': {
        this.clearAwaitingResponse()
        // Finalize orphaned streaming parts
        if (this.currentTurnMessageId) {
          const existing = this.session.getMessage(this.currentTurnMessageId)
          if (existing) {
            const finalizedParts = finalizeStreamingParts(existing.parts)
            this.safeUpdateMessage({ ...existing, parts: finalizedParts })
          }
          this.currentTurnMessageId = null
          this.persistTurnState()
        }

        // Persist error as a visible system message so user sees what happened
        this.turnCounter++
        const errorMsgId = `err-${this.turnCounter}`
        const errorMsg: SessionMessage = {
          id: errorMsgId,
          role: 'system',
          parts: [{ type: 'text', text: `⚠ Error: ${event.error}` }],
          createdAt: new Date(),
        }
        this.safeAppendMessage(errorMsg)
        this.broadcastMessage(errorMsg)

        // Transition to idle — session remains interactive and resumable via
        // sdk_session_id. The error text is already persisted as a visible
        // system message (see above). Clears active_callback_token so the
        // current runner is terminal; sendMessage will dial a fresh resume runner
        // on the user's next turn.
        this.updateState({
          status: 'idle',
          error: event.error,
          active_callback_token: undefined,
        })
        {
          const _now = new Date().toISOString()
          this.syncStatusAndErrorToD1('idle', event.error ?? null, null, _now)
        }
        this.ctx.waitUntil(
          this.dispatchPush(
            {
              title: this.state.project || 'Duraclaw',
              body: `Error: ${event.error}`,
              url: `/?session=${this.state.session_id}`,
              tag: `session-${this.state.session_id}`,
              sessionId: this.state.session_id ?? '',
            },
            'error',
          ),
        )
        break
      }

      // P3 B4: parse `context_usage` to `ContextUsage`, drain probe resolvers,
      // and update `session_meta.context_usage_json` + cached_at. The original
      // gateway_event broadcast is retained (per P3 brief Non-Goals: keep
      // existing client handlers live until the deferred consumer-migration
      // issue swaps them to REST).
      case 'context_usage': {
        const rawUsage = event.usage ?? {}
        const parsed: ContextUsage = {
          totalTokens: (rawUsage.totalTokens as number) ?? 0,
          maxTokens: (rawUsage.maxTokens as number) ?? 0,
          percentage: (rawUsage.percentage as number) ?? 0,
          model: rawUsage.model as string | undefined,
          isAutoCompactEnabled: rawUsage.isAutoCompactEnabled as boolean | undefined,
          autoCompactThreshold: rawUsage.autoCompactThreshold as number | undefined,
        }
        // Drain any awaiters first so they settle on the fresh value rather
        // than the pre-write cache.
        const resolvers = this.contextUsageResolvers.splice(0)
        for (const r of resolvers) {
          try {
            r.resolve(parsed)
          } catch {
            // Defensive: never let a resolver throw tank the event loop.
          }
        }
        // Persist into the typed session_meta cache so subsequent calls
        // within the 5s TTL hit the fresh row without re-probing.
        try {
          const cachedAt = Date.now()
          this.sql`UPDATE session_meta
            SET context_usage_json = ${JSON.stringify(parsed)},
                context_usage_cached_at = ${cachedAt},
                updated_at = ${cachedAt}
            WHERE id = 1`
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] Failed to persist context_usage cache:`, err)
        }
        // Spec #37 B5: mirror context_usage onto the D1 session row with a 5s
        // trailing-edge debounce so sidebar / history cards track live usage.
        this.syncContextUsageToD1(JSON.stringify(parsed))
        // Retained WS broadcast — consumer migration is a separate issue.
        this.broadcastGatewayEvent(event)
        break
      }

      // Events that don't produce message parts — just broadcast raw
      default: {
        // GH#50 B9: tolerant drop for legacy events from in-flight pre-B7
        // runners during the rollout window. These frames are logged once
        // then silently dropped.
        const type = (event as { type: string }).type
        if (type === 'heartbeat' || type === 'session_state_changed') {
          const sid =
            (event as { session_id?: string | null }).session_id ?? this.state.session_id ?? null
          this.handleLegacyEvent(type, sid)
          break
        }
        // rewind_result, rate_limit, task_started, task_progress,
        // task_notification — broadcast as-is
        this.broadcastGatewayEvent(event)
        break
      }
    }
  }
}
