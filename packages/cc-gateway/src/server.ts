import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireAuth } from "./auth.js";
import { initState, removeSession } from "./state.js";
import { discoverWorktrees } from "./worktrees.js";
import {
  createSession,
  resumeSession,
  abortSession,
  getActiveSessionMap,
  resolvePendingAnswer,
} from "./sessions.js";
import type {
  GatewayState,
  HealthResponse,
  StatusResponse,
  CreateSessionRequest,
  ResumeSessionRequest,
  AnswerSessionRequest,
} from "./types.js";

const PORT = Number(process.env.CC_GATEWAY_PORT ?? 9877);
const startedAt = Date.now();

// ── Helpers ──────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Extract :id from /sessions/:id or /sessions/:id/... */
function extractSessionId(url: string): string | null {
  const match = url.match(/^\/sessions\/([^/]+)/);
  return match?.[1] ?? null;
}

// ── Route Handlers ───────────────────────────────────────────────────

function handleHealth(res: ServerResponse): void {
  const body: HealthResponse = {
    status: "ok",
    version: "0.1.0",
    uptime_ms: Date.now() - startedAt,
  };
  json(res, 200, body);
}

async function handleListWorktrees(
  state: GatewayState,
  res: ServerResponse,
): Promise<void> {
  const worktrees = await discoverWorktrees(getActiveSessionMap());
  json(res, 200, worktrees);
}

async function handleCreateSession(
  state: GatewayState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  const body = parseJson<CreateSessionRequest>(raw);
  if (!body?.worktree || !body?.prompt) {
    json(res, 400, { error: "Missing required fields: worktree, prompt" });
    return;
  }
  await createSession(state, body, res);
}

async function handleResumeSession(
  state: GatewayState,
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  const body = parseJson<ResumeSessionRequest>(raw);
  if (!body?.prompt) {
    json(res, 400, { error: "Missing required field: prompt" });
    return;
  }
  await resumeSession(state, sessionId, body, res);
}

async function handleAbortSession(
  state: GatewayState,
  sessionId: string,
  res: ServerResponse,
): Promise<void> {
  const result = await abortSession(state, sessionId);
  if (!result.success) {
    json(res, result.error?.includes("not found") ? 404 : 400, {
      error: result.error,
    });
    return;
  }
  json(res, 200, { session_id: sessionId, status: "aborted" });
}

function handleListSessions(
  state: GatewayState,
  res: ServerResponse,
): void {
  const sessions = Object.values(state.sessions).map((s) => ({
    id: s.id,
    worktree: s.worktree,
    status: s.status,
    model: s.model,
    created_at: s.created_at,
    duration_ms: s.duration_ms,
    total_cost_usd: s.total_cost_usd,
  }));
  json(res, 200, sessions);
}

function handleGetSession(
  state: GatewayState,
  sessionId: string,
  res: ServerResponse,
): void {
  const session = state.sessions[sessionId];
  if (!session) {
    json(res, 404, { error: `Session "${sessionId}" not found` });
    return;
  }
  json(res, 200, session);
}

async function handleAnswerSession(
  state: GatewayState,
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const session = state.sessions[sessionId];
  if (!session) {
    json(res, 404, { error: `Session "${sessionId}" not found` });
    return;
  }
  if (session.status !== "running") {
    json(res, 400, { error: "Session is not running" });
    return;
  }

  const raw = await readBody(req);
  const body = parseJson<AnswerSessionRequest>(raw);
  if (!body?.answers || typeof body.answers !== "object") {
    json(res, 400, { error: "Missing required field: answers (object)" });
    return;
  }

  const resolved = resolvePendingAnswer(sessionId, body.answers);
  if (!resolved) {
    json(res, 409, { error: "No pending AskUserQuestion for this session" });
    return;
  }

  json(res, 200, { session_id: sessionId, accepted: true });
}

async function handleDeleteSession(
  state: GatewayState,
  sessionId: string,
  res: ServerResponse,
): Promise<void> {
  const session = state.sessions[sessionId];
  if (!session) {
    json(res, 404, { error: `Session "${sessionId}" not found` });
    return;
  }
  if (session.status === "running") {
    json(res, 409, { error: "Cannot delete a running session. Abort it first." });
    return;
  }
  await removeSession(state, sessionId);
  json(res, 200, { session_id: sessionId, deleted: true });
}

async function handleStatus(
  state: GatewayState,
  res: ServerResponse,
): Promise<void> {
  const sessions = Object.values(state.sessions);
  const worktrees = await discoverWorktrees(getActiveSessionMap());

  const body: StatusResponse = {
    server: state.server,
    sessions: {
      total: sessions.length,
      running: sessions.filter((s) => s.status === "running").length,
      completed: sessions.filter((s) => s.status === "completed").length,
      failed: sessions.filter((s) => s.status === "failed").length,
      aborted: sessions.filter((s) => s.status === "aborted").length,
    },
    worktrees,
  };
  json(res, 200, body);
}

// ── Router ───────────────────────────────────────────────────────────

async function handleRequest(
  state: GatewayState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { method } = req;
  const url = (req.url ?? "/").split("?")[0]; // strip query string

  // Health check — no auth
  if (method === "GET" && url === "/health") {
    handleHealth(res);
    return;
  }

  // All other endpoints require auth
  if (!requireAuth(req, res)) return;

  // GET /worktrees
  if (method === "GET" && url === "/worktrees") {
    await handleListWorktrees(state, res);
    return;
  }

  // GET /status
  if (method === "GET" && url === "/status") {
    await handleStatus(state, res);
    return;
  }

  // POST /sessions — create
  if (method === "POST" && url === "/sessions") {
    await handleCreateSession(state, req, res);
    return;
  }

  // GET /sessions — list
  if (method === "GET" && url === "/sessions") {
    handleListSessions(state, res);
    return;
  }

  // Routes with session ID
  const sessionId = extractSessionId(url);
  if (sessionId) {
    // POST /sessions/:id/message — resume
    if (method === "POST" && url === `/sessions/${sessionId}/message`) {
      await handleResumeSession(state, sessionId, req, res);
      return;
    }

    // POST /sessions/:id/abort
    if (method === "POST" && url === `/sessions/${sessionId}/abort`) {
      await handleAbortSession(state, sessionId, res);
      return;
    }

    // POST /sessions/:id/answer — resolve pending AskUserQuestion
    if (method === "POST" && url === `/sessions/${sessionId}/answer`) {
      await handleAnswerSession(state, sessionId, req, res);
      return;
    }

    // GET /sessions/:id
    if (method === "GET" && url === `/sessions/${sessionId}`) {
      handleGetSession(state, sessionId, res);
      return;
    }

    // DELETE /sessions/:id
    if (method === "DELETE" && url === `/sessions/${sessionId}`) {
      await handleDeleteSession(state, sessionId, res);
      return;
    }
  }

  json(res, 404, { error: "Not found" });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const state = await initState(PORT);

  console.log(`[cc-gateway] Initializing on port ${PORT} (pid ${process.pid})`);

  const worktrees = await discoverWorktrees({});
  console.log(`[cc-gateway] Discovered ${worktrees.length} worktrees:`);
  for (const wt of worktrees) {
    console.log(`  ${wt.name} (${wt.branch}) → ${wt.path}`);
  }

  const server = http.createServer((req, res) => {
    handleRequest(state, req, res).catch((err) => {
      console.error("[cc-gateway] Unhandled error:", err);
      if (!res.headersSent) {
        json(res, 500, { error: "Internal server error" });
      }
    });
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[cc-gateway] Listening on http://127.0.0.1:${PORT}`);
  });

  // Graceful shutdown
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      console.log(`\n[cc-gateway] Received ${signal}, shutting down...`);
      server.close(() => {
        console.log("[cc-gateway] Server closed");
        process.exit(0);
      });
      // Force exit after 5s
      setTimeout(() => process.exit(1), 5000);
    });
  }
}

main().catch((err) => {
  console.error("[cc-gateway] Fatal:", err);
  process.exit(1);
});
