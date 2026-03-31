import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { GatewayState, SessionInfo, CreateSessionRequest, ResumeSessionRequest } from "./types.js";
import { updateSession } from "./state.js";
import { buildCleanEnv } from "./env.js";
import { initSSE, sendEvent, startHeartbeat, endSSE } from "./sse.js";
import { discoverWorktrees, resolveWorktree } from "./worktrees.js";

// Map of worktree_path → session_id for active sessions
const activeByWorktree = new Map<string, string>();
// Map of session_id → AbortController for running sessions
const abortControllers = new Map<string, AbortController>();
// Map of session_id → pending AskUserQuestion resolver
const pendingAnswers = new Map<
  string,
  { resolve: (answers: Record<string, string>) => void; reject: (err: Error) => void }
>();

/**
 * Resolve a pending AskUserQuestion for the given session.
 * Returns true if there was a pending question, false otherwise.
 */
export function resolvePendingAnswer(
  sessionId: string,
  answers: Record<string, string>,
): boolean {
  const pending = pendingAnswers.get(sessionId);
  if (!pending) return false;
  pendingAnswers.delete(sessionId);
  pending.resolve(answers);
  return true;
}

/** Build map of active sessions by worktree path. */
export function getActiveSessionMap(): Record<string, string> {
  return Object.fromEntries(activeByWorktree);
}

/**
 * Create a new session: start SDK query() and stream SSE events.
 */
export async function createSession(
  state: GatewayState,
  req: CreateSessionRequest,
  res: ServerResponse,
): Promise<void> {
  // Resolve worktree
  const worktreePath = await resolveWorktree(req.worktree);
  if (!worktreePath) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Worktree "${req.worktree}" not found` }));
    return;
  }

  // Check for active session on this worktree
  const existingId = activeByWorktree.get(worktreePath);
  if (existingId && state.sessions[existingId]?.status === "running") {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: `Worktree "${req.worktree}" already has an active session: ${existingId}`,
      }),
    );
    return;
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  const session: SessionInfo = {
    id,
    worktree: req.worktree,
    worktree_path: worktreePath,
    branch: "unknown",
    status: "running",
    model: req.model ?? null,
    prompt: req.prompt,
    created_at: now,
    updated_at: now,
    duration_ms: null,
    total_cost_usd: null,
    result: null,
    error: null,
    num_turns: null,
    sdk_session_id: null,
  };

  state.sessions[id] = session;
  activeByWorktree.set(worktreePath, id);
  await updateSession(state, id, {});

  // Start SSE stream
  initSSE(res);
  const stopHeartbeat = startHeartbeat(res);

  // Abort controller for cancellation
  const ac = new AbortController();
  abortControllers.set(id, ac);

  // Abort on client disconnect
  res.on("close", () => {
    if (session.status === "running") {
      ac.abort();
    }
  });

  const startTime = Date.now();

  // Run SDK query in background
  runQuery(state, id, session, req, res, ac, stopHeartbeat, startTime);
}

/**
 * Resume an existing session with a new prompt.
 */
export async function resumeSession(
  state: GatewayState,
  sessionId: string,
  req: ResumeSessionRequest,
  res: ServerResponse,
): Promise<void> {
  const session = state.sessions[sessionId];
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Session "${sessionId}" not found` }));
    return;
  }

  if (session.status === "running") {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session is already running" }));
    return;
  }

  // Mark as running again
  session.status = "running";
  session.error = null;
  session.result = null;
  activeByWorktree.set(session.worktree_path, sessionId);
  await updateSession(state, sessionId, { status: "running" });

  initSSE(res);
  const stopHeartbeat = startHeartbeat(res);

  const ac = new AbortController();
  abortControllers.set(sessionId, ac);

  res.on("close", () => {
    if (session.status === "running") {
      ac.abort();
    }
  });

  const startTime = Date.now();

  const fakeReq: CreateSessionRequest = {
    worktree: session.worktree,
    prompt: req.prompt,
    model: session.model ?? undefined,
  };

  // Use the SDK session ID for resuming the SDK conversation
  const sdkResumeId = session.sdk_session_id ?? sessionId;
  runQuery(state, sessionId, session, fakeReq, res, ac, stopHeartbeat, startTime, sdkResumeId);
}

/**
 * Abort a running session.
 */
export async function abortSession(
  state: GatewayState,
  sessionId: string,
): Promise<{ success: boolean; error?: string }> {
  const session = state.sessions[sessionId];
  if (!session) {
    return { success: false, error: `Session "${sessionId}" not found` };
  }

  if (session.status !== "running") {
    return { success: false, error: "Session is not running" };
  }

  const ac = abortControllers.get(sessionId);
  if (ac) {
    ac.abort();
    abortControllers.delete(sessionId);
  }

  await updateSession(state, sessionId, { status: "aborted" });
  activeByWorktree.delete(session.worktree_path);

  return { success: true };
}

// ── Internal ─────────────────────────────────────────────────────────

async function runQuery(
  state: GatewayState,
  id: string,
  session: SessionInfo,
  req: CreateSessionRequest,
  res: ServerResponse,
  ac: AbortController,
  stopHeartbeat: () => void,
  startTime: number,
  resumeSessionId?: string,
): Promise<void> {
  try {
    // Dynamic import — the SDK is ESM-only
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const options: Record<string, unknown> = {
      abortController: ac,
      cwd: session.worktree_path,
      env: buildCleanEnv(),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project", "local"],
    };

    if (req.model) options.model = req.model;
    if (req.system_prompt) options.systemPrompt = req.system_prompt;
    if (req.allowed_tools) options.allowedTools = req.allowed_tools;
    if (req.max_turns) options.maxTurns = req.max_turns;
    if (req.max_budget_usd) options.maxBudgetUsd = req.max_budget_usd;

    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

    // Intercept AskUserQuestion: send SSE event and wait for POST /sessions/:id/answer
    options.canUseTool = async (toolName: string, input: Record<string, unknown>) => {
      if (toolName !== "AskUserQuestion") {
        return { behavior: "allow" };
      }

      sendEvent(res, "user_question", {
        session_id: id,
        questions: (input as any).questions ?? [],
      });

      const answers = await new Promise<Record<string, string>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingAnswers.delete(id);
          reject(new Error("AskUserQuestion timed out after 5 minutes"));
        }, 5 * 60 * 1000);

        pendingAnswers.set(id, {
          resolve: (a) => { clearTimeout(timeout); resolve(a); },
          reject: (e) => { clearTimeout(timeout); reject(e); },
        });

        ac.signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          pendingAnswers.delete(id);
          reject(new Error("Session aborted"));
        }, { once: true });
      });

      return { behavior: "allow", updatedInput: { ...input, answers } };
    };

    const iter = query({ prompt: req.prompt, options: options as any });

    for await (const message of iter) {
      if (ac.signal.aborted) break;

      if (message.type === "system" && (message as any).subtype === "init") {
        const sdkSessionId = (message as any).session_id as string | undefined;
        if (sdkSessionId) {
          session.sdk_session_id = sdkSessionId;
          await updateSession(state, id, { sdk_session_id: sdkSessionId });
        }
        const model = (message as any).model ?? null;
        const tools = (message as any).tools ?? [];
        if (model) session.model = model;

        sendEvent(res, "session_init", {
          session_id: id,
          sdk_session_id: sdkSessionId,
          worktree: session.worktree,
          model,
          tools,
        });
      } else if (message.type === "assistant") {
        sendEvent(res, "assistant", {
          uuid: (message as any).uuid,
          content: (message as any).message?.content ?? [],
        });
      } else if (message.type === "result") {
        const result = message as any;
        const duration = Date.now() - startTime;

        await updateSession(state, id, {
          status: result.subtype === "success" ? "completed" : "failed",
          duration_ms: duration,
          total_cost_usd: result.total_cost_usd ?? null,
          result: result.result ?? null,
          num_turns: result.num_turns ?? null,
          error: result.subtype !== "success"
            ? (result.errors?.join("; ") ?? "Unknown error")
            : null,
        });

        sendEvent(res, "result", {
          session_id: id,
          subtype: result.subtype,
          duration_ms: duration,
          total_cost_usd: result.total_cost_usd ?? null,
          result: result.result ?? null,
          num_turns: result.num_turns ?? null,
          is_error: result.is_error ?? false,
        });
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Don't treat abort as error
    if (ac.signal.aborted) {
      await updateSession(state, id, { status: "aborted" });
    } else {
      await updateSession(state, id, {
        status: "failed",
        error: errMsg,
        duration_ms: Date.now() - startTime,
      });
      sendEvent(res, "error", { session_id: id, error: errMsg });
    }
  } finally {
    stopHeartbeat();
    endSSE(res);
    abortControllers.delete(id);
    if (session.status !== "running") {
      activeByWorktree.delete(session.worktree_path);
    }
  }
}
