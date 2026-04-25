import {
  CONTEXT_USAGE_HEADER,
  DIFFICULTY_HINT_HEADER,
  OPENCLAW_SESSION_HEADER,
  type RouterOptions,
  SESSION_BUDGET_HEADER,
  SESSION_HEADER,
  TURN_INDEX_HEADER,
} from './types.js'

/**
 * Translate `RouterOptions` into the `x-session-id` / `x-openclaw-session-key`
 * + `x-uncommon-route-*` enrichment header pairs UncommonRoute reads in
 * `proxy.py::_resolve_session_context`.
 *
 * Numeric fields are emitted only when they're finite numbers — `NaN` /
 * `Infinity` would produce a header value the proxy can't coerce, and
 * the proxy's coercers fall back to sentinels anyway, so we don't bother
 * sending them.
 */
export function sessionHeadersFromOptions(opts: RouterOptions): Record<string, string> {
  const headers: Record<string, string> = {}

  if (opts.sessionId) headers[SESSION_HEADER] = opts.sessionId
  if (opts.openclawSessionKey) headers[OPENCLAW_SESSION_HEADER] = opts.openclawSessionKey

  if (typeof opts.turnIndex === 'number' && Number.isFinite(opts.turnIndex)) {
    headers[TURN_INDEX_HEADER] = String(Math.trunc(opts.turnIndex))
  }
  if (typeof opts.sessionBudgetUsd === 'number' && Number.isFinite(opts.sessionBudgetUsd)) {
    headers[SESSION_BUDGET_HEADER] = String(opts.sessionBudgetUsd)
  }
  if (opts.difficultyHint) {
    headers[DIFFICULTY_HINT_HEADER] = opts.difficultyHint
  }
  if (typeof opts.contextUsagePct === 'number' && Number.isFinite(opts.contextUsagePct)) {
    headers[CONTEXT_USAGE_HEADER] = String(opts.contextUsagePct)
  }

  return headers
}
