// ── VPS Executor Messages ───────────────────────────────────────────

export type VpsCommand =
  | {
      type: 'execute'
      worktree: string
      prompt: string
      model?: string
      system_prompt?: string
      allowed_tools?: string[]
      max_turns?: number
      max_budget_usd?: number
    }
  | { type: 'resume'; worktree: string; prompt: string; sdk_session_id: string }
  | { type: 'abort'; session_id: string }
  | { type: 'answer'; session_id: string; answers: Record<string, string> }

export type ExecuteCommand = Extract<VpsCommand, { type: 'execute' }>
export type ResumeCommand = Extract<VpsCommand, { type: 'resume' }>
export type AbortCommand = Extract<VpsCommand, { type: 'abort' }>
export type AnswerCommand = Extract<VpsCommand, { type: 'answer' }>

export type VpsEvent =
  | {
      type: 'session.init'
      session_id: string
      sdk_session_id: string | null
      worktree: string
      model: string | null
      tools: string[]
    }
  | { type: 'assistant'; session_id: string; uuid: string; content: unknown[] }
  | { type: 'tool_result'; session_id: string; uuid: string; content: unknown[] }
  | { type: 'user_question'; session_id: string; questions: unknown[] }
  | {
      type: 'result'
      session_id: string
      subtype: string
      duration_ms: number
      total_cost_usd: number | null
      result: string | null
      num_turns: number | null
      is_error: boolean
    }
  | { type: 'error'; session_id: string | null; error: string }

// ── Worktree ─────────────────────────────────────────────────────────

export interface WorktreeInfo {
  name: string
  path: string
  branch: string
  active_session: string | null
}

// ── WebSocket Data ──────────────────────────────────────────────────

/** Data attached to each WebSocket connection via server.upgrade(). */
export interface WsData {
  worktree: string | null
}

// ── Session Context ─────────────────────────────────────────────────

export interface SessionContext {
  sessionId: string
  abortController: AbortController
  pendingAnswer: {
    resolve: (answers: Record<string, string>) => void
    reject: (err: Error) => void
  } | null
}
