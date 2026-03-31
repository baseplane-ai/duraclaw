// ── Session ──────────────────────────────────────────────────────────

export type SessionStatus = "running" | "completed" | "failed" | "aborted";

export interface SessionInfo {
  id: string;
  worktree: string;
  worktree_path: string;
  branch: string;
  status: SessionStatus;
  model: string | null;
  prompt: string;
  created_at: string;
  updated_at: string;
  duration_ms: number | null;
  total_cost_usd: number | null;
  result: string | null;
  error: string | null;
  num_turns: number | null;
  sdk_session_id: string | null;
}

// ── Gateway State ────────────────────────────────────────────────────

export interface GatewayState {
  server: {
    pid: number;
    started_at: string;
    port: number;
    version: string;
  };
  sessions: Record<string, SessionInfo>;
}

// ── Worktree ─────────────────────────────────────────────────────────

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  active_session: string | null;
}

// ── API Request / Response ───────────────────────────────────────────

export interface CreateSessionRequest {
  worktree: string;
  prompt: string;
  model?: string;
  system_prompt?: string;
  allowed_tools?: string[];
  max_turns?: number;
  max_budget_usd?: number;
}

export interface ResumeSessionRequest {
  prompt: string;
}

export interface AnswerSessionRequest {
  answers: Record<string, string>;
}

export interface ErrorResponse {
  error: string;
}

export interface HealthResponse {
  status: "ok";
  version: string;
  uptime_ms: number;
}

export interface StatusResponse {
  server: GatewayState["server"];
  sessions: {
    total: number;
    running: number;
    completed: number;
    failed: number;
    aborted: number;
  };
  worktrees: WorktreeInfo[];
}
