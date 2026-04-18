import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { agentSessions } from '~/db/schema'
import type { DiscoveredSession, Env } from '~/lib/types'

/**
 * Cron-triggered discovery sync. Runs every 5 minutes (see wrangler.toml
 * `[triggers] crons`). Replaces the previous in-DO alarm in
 * ProjectRegistry.alarm(). Behaviour per B-API-5:
 *
 * - Fetch CC_GATEWAY_URL/sessions/discover with a 10s timeout.
 * - On any failure (network, non-2xx, malformed JSON) log a warning and
 *   exit cleanly. No retry; the next 5-minute tick retries from scratch.
 * - Per-row UPSERT into agent_sessions keyed on sdk_session_id, in a
 *   single Drizzle transaction. Per-row try/catch on conflict so a single
 *   bad row doesn't take down the whole sync.
 *
 * The cron has no per-user context, so synthetic 'system' is used as the
 * userId — getOwnedSession() treats 'system' rows as shared.
 */
export async function scheduled(
  _event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  if (!env.CC_GATEWAY_URL) {
    console.warn('[cron] CC_GATEWAY_URL not configured — skipping discovery sync')
    return
  }

  const httpBase = env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const discoverUrl = new URL('/sessions/discover', httpBase)
  const headers: Record<string, string> = {}
  if (env.CC_GATEWAY_SECRET) {
    headers.Authorization = `Bearer ${env.CC_GATEWAY_SECRET}`
  }

  let sessions: DiscoveredSession[]
  try {
    const resp = await fetch(discoverUrl.toString(), {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) {
      console.warn(`[cron] gateway unreachable: status=${resp.status}`)
      return
    }
    const text = await resp.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      console.warn(`[cron] invalid response shape: ${text.slice(0, 200)}`)
      return
    }
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray((data as { sessions?: unknown }).sessions)
    ) {
      console.warn(`[cron] invalid response shape: ${text.slice(0, 200)}`)
      return
    }
    sessions = (data as { sessions: DiscoveredSession[] }).sessions
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[cron] gateway unreachable: ${message}`)
    return
  }

  if (sessions.length === 0) {
    return
  }

  const db = drizzle(env.AUTH_DB, { schema })
  const now = new Date().toISOString()

  await db.transaction(async (tx) => {
    for (const s of sessions) {
      try {
        const userId = (s as DiscoveredSession & { user?: string }).user || 'system'
        const id = s.sdk_session_id
        const row = {
          id,
          userId,
          project: s.project,
          status: 'idle',
          model: null as string | null,
          sdkSessionId: s.sdk_session_id,
          createdAt: s.started_at || now,
          updatedAt: s.last_activity || now,
          lastActivity: s.last_activity || now,
          numTurns: null as number | null,
          prompt: null as string | null,
          summary: s.summary || null,
          title: s.title ?? null,
          tag: s.tag ?? null,
          origin: 'discovered',
          agent: s.agent ?? 'claude',
          archived: false,
          durationMs: null as number | null,
          totalCostUsd: null as number | null,
          messageCount: s.message_count ?? null,
          kataMode: null as string | null,
          kataIssue: null as number | null,
          kataPhase: null as string | null,
        }

        await tx
          .insert(agentSessions)
          .values(row)
          .onConflictDoUpdate({
            target: agentSessions.sdkSessionId,
            set: {
              project: row.project,
              lastActivity: row.lastActivity,
              updatedAt: row.updatedAt,
              summary: row.summary,
              title: row.title,
              tag: row.tag,
              messageCount: row.messageCount,
              agent: row.agent,
            },
          })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[cron] upsert failed for ${s.sdk_session_id}: ${message}`)
      }
    }
  })
}
