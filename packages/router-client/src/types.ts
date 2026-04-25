/**
 * Public types for @duraclaw/router-client.
 *
 * The package is a zero-dep client for UncommonRoute (a local LLM router
 * that sits between a Claude Agent SDK / Anthropic SDK / OpenAI SDK caller
 * and the upstream API). The entire surface is `baseURL` + header + fetch
 * configuration — we deliberately don't pin a specific SDK version so this
 * package composes with whatever Duraclaw's session-runner, MatchBox, or
 * any downstream consumer is already using.
 *
 * Router reference:
 *   https://github.com/anjieyang/IYKYK — response headers produced by the
 *   proxy are documented in `uncommon_route/proxy.py::_set_header` calls.
 */

/**
 * Minimal fetch signature shared by WHATWG fetch, undici, `node:fetch`, and
 * the fetch impls embedded in `openai`/`@anthropic-ai/sdk`. Typed as a free
 * function so consumers don't need DOM lib types leaked into their builds.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Options accepted by every helper in this package. */
export interface RouterOptions {
  /**
   * Base URL of the UncommonRoute proxy — typically `http://127.0.0.1:8403`.
   * Trailing slashes are normalised away.
   */
  routerUrl: string

  /**
   * Stable session identifier propagated as `x-session-id` on every request.
   * UncommonRoute uses this to derive per-session cache keys; Duraclaw
   * session ids from the SessionDO slot straight in.
   */
  sessionId?: string

  /**
   * OpenClaw-compatible session header. Takes precedence over `sessionId`
   * when both are set — matches header precedence in
   * `uncommon_route/proxy.py::_resolve_session_id`.
   */
  openclawSessionKey?: string

  /**
   * Per-session enrichment hints the router uses for session-aware
   * routing. All optional; omitted fields are simply not sent. Field
   * shapes mirror `proxy.py::_resolve_session_context`:
   *   - turnIndex          → `x-uncommon-route-turn-index` (int)
   *   - sessionBudgetUsd   → `x-uncommon-route-session-budget-usd` (float)
   *   - difficultyHint     → `x-uncommon-route-difficulty-hint`
   *                          ("easy" | "medium" | "hard" | "reasoning")
   *   - contextUsagePct    → `x-uncommon-route-context-usage-pct` (0..1)
   */
  turnIndex?: number
  sessionBudgetUsd?: number
  difficultyHint?: 'easy' | 'medium' | 'hard' | 'reasoning'
  contextUsagePct?: number

  /**
   * Extra headers merged into every request. Keys are treated
   * case-insensitively against the defaults the client adds; user values
   * take precedence.
   */
  headers?: Record<string, string>

  /**
   * Custom fetch implementation. Defaults to `globalThis.fetch` (Node 18+,
   * Workers, browsers). Supply `undici.fetch`, `node-fetch`, or a stub as
   * needed.
   */
  fetch?: FetchLike
}

/**
 * Structured view over the `x-uncommon-route-*` response headers the proxy
 * stamps on every routed response. Field names mirror
 * `uncommon_route/proxy.py::_set_header` calls around line 2379.
 *
 * `null` means the header wasn't present on the response (the proxy may
 * skip some fields on passthrough, and we don't force callers to guard
 * every access).
 */
export interface RouteMetadata {
  mode: string | null
  requestId: string | null
  model: string | null
  tier: string | null
  decisionTier: string | null
  step: string | null
  inputTokensBefore: number | null
  inputTokensAfter: number | null
  artifacts: number | null
  transport: string | null
  cacheMode: string | null
  cacheFamily: string | null
  cacheBreakpoints: number | null
  cacheKey: string | null
  semanticCalls: number | null
  semanticFallbacks: number | null
  checkpoints: number | null
  rehydrated: number | null
}

/** Default session-id header name. Matches `proxy.py::_resolve_session_id`. */
export const SESSION_HEADER = 'x-session-id'

/** OpenClaw-specific session header name. */
export const OPENCLAW_SESSION_HEADER = 'x-openclaw-session-key'

/**
 * Session-aware routing enrichment headers. Names mirror
 * `proxy.py::_resolve_session_context` 1:1 so the wire format is
 * one-edit-per-side when fields are added or renamed.
 */
export const TURN_INDEX_HEADER = 'x-uncommon-route-turn-index'
export const SESSION_BUDGET_HEADER = 'x-uncommon-route-session-budget-usd'
export const DIFFICULTY_HINT_HEADER = 'x-uncommon-route-difficulty-hint'
export const CONTEXT_USAGE_HEADER = 'x-uncommon-route-context-usage-pct'
