// ── Session State ────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted'

export interface SessionState {
  id: string
  worktree: string
  worktree_path: string
  status: SessionStatus
  model: string | null
  prompt: string
  created_at: string
  updated_at: string
  duration_ms: number | null
  total_cost_usd: number | null
  result: string | null
  error: string | null
  num_turns: number | null
  sdk_session_id: string | null
  pending_question: unknown[] | null
}

// ── VPS Executor Messages ───────────────────────────────────────────

export type VpsCommand =
  | { type: 'execute'; worktree: string; prompt: string; model?: string; system_prompt?: string; allowed_tools?: string[]; max_turns?: number; max_budget_usd?: number }
  | { type: 'resume'; worktree: string; prompt: string; sdk_session_id: string }
  | { type: 'abort'; session_id: string }
  | { type: 'answer'; session_id: string; answers: Record<string, string> }

export type VpsEvent =
  | { type: 'session.init'; session_id: string; sdk_session_id: string | null; worktree: string; model: string | null; tools: string[] }
  | { type: 'assistant'; session_id: string; uuid: string; content: unknown[] }
  | { type: 'tool_result'; session_id: string; uuid: string; content: unknown[] }
  | { type: 'user_question'; session_id: string; questions: unknown[] }
  | { type: 'result'; session_id: string; subtype: string; duration_ms: number; total_cost_usd: number | null; result: string | null; num_turns: number | null; is_error: boolean }
  | { type: 'error'; session_id: string | null; error: string }

// ── Registry ────────────────────────────────────────────────────────

export interface RegistryState {
  worktree_locks: Record<string, string> // worktree_name → session_id
}

export interface SessionSummary {
  id: string
  worktree: string
  status: SessionStatus
  model: string | null
  created_at: string
  updated_at: string
}

// ── CF Env ──────────────────────────────────────────────────────────

export interface Env {
  SESSION_AGENT: DurableObjectNamespace
  SESSION_REGISTRY: DurableObjectNamespace
  CC_GATEWAY_URL?: string
  CC_GATEWAY_SECRET?: string
}
