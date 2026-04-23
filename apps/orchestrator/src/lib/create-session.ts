/**
 * Session-creation helper — extracted from `POST /api/sessions` so the
 * auto-advance path (`tryAutoAdvance` in ~/lib/auto-advance) can spawn a
 * successor without round-tripping through the same-worker REST endpoint.
 *
 * Mirrors the REST handler's behavior exactly:
 *   - resolves the project path via the gateway's /projects listing;
 *   - creates (or rebinds) the SessionDO via idFromName / newUniqueId;
 *   - posts /create on the DO to hydrate its SessionMeta;
 *   - inserts / upserts the D1 `agent_sessions` row;
 *   - broadcasts the row via `broadcastSessionRow` (wrapped in waitUntil).
 */

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { agentSessions } from '~/db/schema'
import { broadcastSessionRow } from '~/lib/broadcast-session'
import { resolveProjectPath } from '~/lib/gateway-files'
import { promptToPreviewText } from '~/lib/prompt-preview'
import type { ContentBlock, Env } from '~/lib/types'

// Match the REST handler's regex for client-supplied session IDs.
const CLIENT_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/

export interface CreateSessionParams {
  project: string
  prompt: string | ContentBlock[]
  model?: string
  system_prompt?: string
  sdk_session_id?: string
  agent?: string
  kataIssue?: number | null
  client_session_id?: string
}

export type CreateSessionResult =
  | { ok: true; sessionId: string }
  | { ok: false; status: number; error: string }

export async function createSession(
  env: Env,
  userId: string,
  params: CreateSessionParams,
  executionCtx: { waitUntil: (p: Promise<unknown>) => void },
): Promise<CreateSessionResult> {
  if (!params.project || !params.prompt) {
    return { ok: false, status: 400, error: 'Missing required fields: project, prompt' }
  }

  if (params.kataIssue !== undefined && params.kataIssue !== null) {
    if (!Number.isInteger(params.kataIssue) || params.kataIssue <= 0) {
      return { ok: false, status: 400, error: 'invalid_kata_issue' }
    }
  }

  const projectPath = await resolveProjectPath(env, params.project)

  // Spec #68 B6 — inherit the project's visibility at creation time. Projects
  // default to 'private'; promoting to 'public' happens via the admin PATCH
  // endpoint. New sessions adopt whatever the project is set to today.
  const db = drizzle(env.AUTH_DB, { schema })
  const projectRows = await db
    .select({ visibility: schema.projects.visibility })
    .from(schema.projects)
    .where(eq(schema.projects.name, params.project))
    .limit(1)
  const visibility: 'public' | 'private' =
    projectRows[0]?.visibility === 'public' ? 'public' : 'private'

  let sessionId: string
  let doId: DurableObjectId
  if (params.client_session_id !== undefined) {
    if (
      !CLIENT_SESSION_ID_RE.test(params.client_session_id) ||
      /^[0-9a-f]{64}$/.test(params.client_session_id)
    ) {
      return { ok: false, status: 400, error: 'invalid_client_session_id' }
    }
    sessionId = params.client_session_id
    doId = env.SESSION_AGENT.idFromName(sessionId)
  } else {
    doId = env.SESSION_AGENT.newUniqueId()
    sessionId = doId.toString()
  }
  const sessionDO = env.SESSION_AGENT.get(doId)

  const now = new Date().toISOString()
  const promptText = promptToPreviewText(params.prompt)

  const baseRow = {
    id: sessionId,
    userId,
    project: params.project,
    status: 'running',
    model: params.model ?? null,
    sdkSessionId: params.sdk_session_id ?? null,
    createdAt: now,
    updatedAt: now,
    lastActivity: now,
    numTurns: null as number | null,
    prompt: promptText,
    summary: null as string | null,
    title: null as string | null,
    tag: null as string | null,
    origin: 'duraclaw',
    agent: params.agent ?? 'claude',
    archived: false,
    durationMs: null as number | null,
    totalCostUsd: null as number | null,
    kataMode: null as string | null,
    kataIssue: typeof params.kataIssue === 'number' ? params.kataIssue : (null as number | null),
    kataPhase: null as string | null,
    visibility,
  }

  // ── D1 INSERT FIRST ──────────────────────────────────────────────────
  // The D1 row MUST exist before the DO spawns the runner. Without it,
  // every API route gates on getAccessibleSession() → 404, so the client
  // can never fetch messages for a session that ran successfully.
  // See: GH incident sess-d62bb777 — DO ran, D1 INSERT failed silently,
  // session became permanently unreachable.
  if (params.sdk_session_id) {
    await db
      .insert(agentSessions)
      .values(baseRow)
      .onConflictDoUpdate({
        target: agentSessions.sdkSessionId,
        set: {
          id: sessionId,
          userId,
          project: params.project,
          status: 'running',
          model: baseRow.model,
          updatedAt: now,
          lastActivity: now,
          agent: baseRow.agent,
        },
      })
  } else {
    await db.insert(agentSessions).values(baseRow)
  }

  // ── Now spawn the DO ─────────────────────────────────────────────────
  // If this fails, the D1 row exists with status='running' but no runner.
  // The next sendMessage will see no gateway conn and re-trigger spawn,
  // or the reaper will eventually mark it idle — both are recoverable.
  const createResponse = await sessionDO.fetch(
    new Request('https://session/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-partykit-room': sessionId,
        'x-user-id': userId,
      },
      body: JSON.stringify({
        project: params.project,
        project_path: projectPath,
        prompt: params.prompt,
        model: params.model,
        system_prompt: params.system_prompt,
        sdk_session_id: params.sdk_session_id,
        agent: params.agent,
        userId,
      }),
    }),
  )

  if (!createResponse.ok) {
    // DO spawn failed — mark the D1 row as errored so it doesn't sit
    // as a phantom 'running' session forever.
    await db
      .update(agentSessions)
      .set({ status: 'error', updatedAt: new Date().toISOString() })
      .where(eq(agentSessions.id, sessionId))
    return { ok: false, status: 500, error: 'Failed to create session' }
  }

  await broadcastSessionRow(env, executionCtx, sessionId, 'insert')

  return { ok: true, sessionId }
}
