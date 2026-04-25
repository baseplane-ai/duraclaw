/**
 * Build the `fetch` + `baseURL` patch that routes Claude Agent SDK calls
 * through an UncommonRoute proxy (see `services/uncommon-route`).
 *
 * Feature-flagged on `UNCOMMON_ROUTE_URL`:
 *   - unset (or empty) → returns `{}`. Zero behavioural change; the SDK
 *     talks to the Anthropic API directly as before.
 *   - set              → returns `{ baseURL, fetch }` pointed at the
 *     router, with `x-session-id` propagated on every call so the router
 *     can derive per-session cache keys and (once session-aware routing
 *     lands upstream) per-session policies.
 *
 * Live chat has to stay on the synchronous path — the batch-analysis
 * lane (queued PR) handles anything that can wait.
 */

import { type FetchLike, routerConfig } from '@duraclaw/router-client'

export interface RouterOptionsPatch {
  baseURL?: string
  fetch?: FetchLike
}

export interface BuildRouterOptionsInput {
  sessionId: string
  env?: NodeJS.ProcessEnv
}

export function buildRouterOptions(input: BuildRouterOptionsInput): RouterOptionsPatch {
  const env = input.env ?? process.env
  const routerUrl = (env.UNCOMMON_ROUTE_URL ?? '').trim()
  if (!routerUrl) return {}

  try {
    const cfg = routerConfig({
      routerUrl,
      sessionId: input.sessionId,
    })
    return { baseURL: cfg.baseURL, fetch: cfg.fetch }
  } catch (err) {
    // Misconfig (malformed URL, empty trim) — warn and fall back to the
    // default Anthropic endpoint. Session-runner correctness should never
    // depend on the proxy being reachable.
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[session-runner] UNCOMMON_ROUTE_URL invalid, ignoring: ${msg}`)
    return {}
  }
}
