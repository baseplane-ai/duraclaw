import type { SpawnConfig } from '~/lib/types'
import { handleRateLimit } from './resume-scheduler'
import { transcriptCountImpl } from './transcript'
import type { SessionDOContext } from './types'

/**
 * Spec #101 Stage 6: HTTP route dispatch extracted from `SessionDO.onRequest`.
 *
 * Returns a Response when a route matches, or `null` to signal the caller
 * should fall through to `super.onRequest(request)` (the Agent base class
 * handles WS upgrades + other framework routes).
 *
 * Auth + ownership gates live in `apps/orchestrator/src/api/index.ts`; the
 * DO trusts pre-validated calls.
 */
export async function handleHttpRequest(
  ctx: SessionDOContext,
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (request.method === 'POST' && url.pathname === '/create') {
    try {
      const body = (await request.json()) as SpawnConfig & {
        userId?: string
        runner_session_id?: string
        project_path?: string
      }
      const userId = request.headers.get('x-user-id') ?? body.userId ?? null
      if (userId) {
        ctx.do.updateState({ userId })
      }

      let result: { ok: boolean; session_id?: string; error?: string }
      if (body.runner_session_id) {
        result = await ctx.do.resumeDiscovered(body, body.runner_session_id)
      } else if (body.prompt === undefined || body.prompt === null) {
        // Deferred-runner flow: create the DO + SessionMeta now, defer the
        // gateway dial until the user's first sendMessage. The fresh-execute
        // fallback in sendMessageImpl reads project/model/agent from
        // SessionMeta to compose the dial.
        result = await ctx.do.initialize(body)
      } else {
        result = await ctx.do.spawn(body)
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
          return new Response(JSON.stringify({ error: 'invalid sinceCreatedAt ISO 8601 string' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        // Keyset-paginated cursor query — see migration v9 composite index.
        // The SDK's `Session.create(this)` leaves `sessionId = ''` so we
        // match on the empty string the rows are written with.
        const rows = [
          ...ctx.sql.exec<{
            content: string
            created_at: string
            modified_at: string | null
          }>(
            `SELECT content, created_at, modified_at FROM assistant_messages
             WHERE session_id = ''
               AND (
                 (created_at > ?)
                 OR (created_at = ? AND id > ?)
               )
             ORDER BY created_at ASC, id ASC
             LIMIT 500`,
            sinceCreatedAt as string,
            sinceCreatedAt as string,
            sinceId as string,
          ),
        ]
        const messages: unknown[] = []
        for (const row of rows) {
          try {
            // v13: enrich the REST cold-load payload with `modifiedAt` so
            // the client seeds a correct tail cursor for its next
            // subscribe:messages.
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
      // Cold-load (no cursor). Bounded to the most recent 500 rows so the
      // recursive CTE doesn't blow the storage-op wall-time on big sessions.
      const rows = [
        ...ctx.sql.exec<{
          content: string
          created_at: string
          modified_at: string | null
        }>(
          `SELECT content, created_at, modified_at FROM assistant_messages
           WHERE session_id = ''
           ORDER BY created_at DESC, id DESC
           LIMIT 500`,
        ),
      ]
      const buffered: Array<Record<string, unknown>> = []
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.content) as Record<string, unknown>
          parsed.modifiedAt = row.modified_at ?? row.created_at
          buffered.push(parsed)
        } catch {
          // Skip unparseable rows.
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

  // GH#38 P1.2: optimistic user-turn ingest via HTTP — used by the
  // `messagesCollection` onInsert mutationFn.
  if (request.method === 'POST' && url.pathname === '/messages') {
    try {
      // Gate body size before parsing — a malicious client could POST a
      // multi-GB body that the DO must fully parse before any validation
      // fires. 64 KiB is ample for message content.
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
      if (typeof body.createdAt !== 'string' || Number.isNaN(new Date(body.createdAt).getTime())) {
        return new Response(
          JSON.stringify({ error: 'createdAt must be a valid ISO 8601 string' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }
      const result = await ctx.do.sendMessage(body.content, {
        client_message_id: body.clientId,
        createdAt: body.createdAt,
        ...(typeof body.senderId === 'string' ? { senderId: body.senderId } : {}),
      })
      if (!result.ok) {
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

  // GH#119 P3: dev-only failover trigger for VP-3 verification. Synthesises
  // a `RateLimitEvent` with the optional `resets_at` from the request body
  // and routes it through the real failover handler — same identity-cooldown
  // write, same LRU resume spawn as a runner-emitted rate_limit. The public
  // Hono route gates on `ENABLE_DEBUG_ENDPOINTS === 'true'`; this handler
  // trusts pre-validated calls.
  //
  // We `await` `handleRateLimit` here (unlike the production rate_limit /
  // result-error paths in `gateway-event-handler.ts`, which fire-and-forget
  // because they run inside the WS dispatch loop and blocking would be
  // wrong) so VP-3 verification is not racy: the response only returns
  // after the failover side-effects (identity-cooldown write + LRU resume
  // spawn) have settled.
  if (request.method === 'POST' && url.pathname === '/debug/simulate-rate-limit') {
    try {
      let resetsAt: string | undefined
      try {
        const body = (await request.json()) as { resets_at?: unknown } | null
        if (body && typeof body.resets_at === 'string') resetsAt = body.resets_at
      } catch {
        // Tolerate missing / non-JSON body — synth event uses fallback.
      }
      const sessionId = ctx.do.name
      try {
        await handleRateLimit(ctx, {
          type: 'rate_limit',
          session_id: sessionId,
          rate_limit_info: resetsAt ? { resets_at: resetsAt } : {},
        })
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (err) {
        ctx.logEvent('error', 'failover', 'simulate-rate-limit handleRateLimit threw', {
          error: err instanceof Error ? err.message : String(err),
        })
        return new Response(JSON.stringify({ ok: false, error: String(err) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }
  }

  // GH#119 P1.1: dev-only transcript-entry count for VP-1 verification.
  // The public Hono route gates on `c.env.ENABLE_DEBUG_ENDPOINTS === 'true'`
  // before forwarding here, so this DO handler does not need its own gate
  // — only the API layer reaches it.
  //
  // `session_transcript.session_id` stores the SDK runner_session_id (the
  // value the SDK passes to `SessionStore.append()`), NOT the duraclaw
  // session id (`ctx.do.name`). Default to `ctx.state.runner_session_id`
  // so the API route can call us without knowing the SDK id. The
  // `?session_id=` override remains for tests and ad-hoc lookups.
  if (request.method === 'GET' && url.pathname === '/debug/transcript-count') {
    try {
      const sessionId = url.searchParams.get('session_id') ?? ctx.state.runner_session_id ?? ''
      if (!sessionId) {
        return new Response(JSON.stringify({ count: 0, reason: 'no runner_session_id yet' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const count = transcriptCountImpl(ctx, sessionId)
      return new Response(JSON.stringify({ count }), {
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }
  }

  // P3: REST scaffolding for contextUsage (B4).
  if (request.method === 'GET' && url.pathname === '/context-usage') {
    try {
      const body = await ctx.do.getContextUsage()
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

  // GH#86 B4: PATCH /api/sessions/:id with `{title}` writes
  // `title_source='user'` to D1 then POSTs here so the DO mirrors the
  // freeze into `session_meta`.
  if (request.method === 'POST' && url.pathname === '/title-set-by-user') {
    try {
      const body = (await request.json()) as { title?: string | null }
      ctx.do.updateState({
        title: body.title ?? null,
        title_source: 'user',
      })
      return new Response(JSON.stringify({ ok: true }), {
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
  // Lightweight status probe — returns the in-memory `state.status` only.
  // Used by `UserSettingsDO.handleWebSocketUpgrade` to prime a freshly-
  // connected user-stream socket with current substates (`waiting_gate`,
  // `pending`, etc.) that the D1 `agent_sessions.status` mirror doesn't
  // carry. Reads no SQLite, runs no D1 queries — just reflects the DO's
  // already-hydrated state.
  if (request.method === 'GET' && url.pathname === '/status') {
    return new Response(JSON.stringify({ status: ctx.state.status }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (request.method === 'GET' && url.pathname === '/kata-state') {
    try {
      const body = await ctx.do.getKataState()
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

  // Stop levers exposed over HTTP so the API layer (or a curl from
  // devtools) can kill a wedged session even when the WS RPC channel
  // is dead. Auth lives in api/index.ts, not here.
  if (request.method === 'POST' && url.pathname === '/abort') {
    try {
      let reason: string | undefined
      try {
        const body = (await request.clone().json()) as { reason?: unknown } | null
        if (body && typeof body.reason === 'string') reason = body.reason
      } catch {
        // No body / non-JSON body → no reason.
      }
      const result = await ctx.do.abort(reason)
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

  if (request.method === 'POST' && url.pathname === '/force-stop') {
    try {
      let reason: string | undefined
      try {
        const body = (await request.clone().json()) as { reason?: unknown } | null
        if (body && typeof body.reason === 'string') reason = body.reason
      } catch {
        // tolerate missing body
      }
      const result = await ctx.do.forceStop(reason)
      return new Response(JSON.stringify(result), {
        // forceStop is best-effort and idempotent; surface the gateway
        // kill outcome via `kill` and let the caller inspect.
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }
  }

  // No route matched — caller should delegate to `super.onRequest`.
  return null
}
