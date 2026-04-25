import { sessionHeadersFromOptions } from './session-headers.js'
import type { FetchLike, RouterOptions } from './types.js'

function resolveBaseFetch(opts: RouterOptions): FetchLike {
  if (opts.fetch) return opts.fetch
  const g = (globalThis as { fetch?: FetchLike }).fetch
  if (typeof g !== 'function') {
    throw new Error(
      '@duraclaw/router-client: no global `fetch` is available. ' +
        'Pass `{ fetch: undiciFetch }` (or similar) via RouterOptions.',
    )
  }
  return g
}

function mergeHeaders(
  existing: HeadersInit | undefined,
  additions: Record<string, string>,
): Headers {
  const merged = new Headers(existing ?? undefined)
  for (const [key, value] of Object.entries(additions)) {
    // User-supplied headers on the per-request init already sit in
    // `existing` — don't clobber them.
    if (merged.has(key)) continue
    merged.set(key, value)
  }
  return merged
}

/**
 * Wrap a fetch implementation so every request gains UncommonRoute's
 * default headers (session id, user-supplied extras). The caller's own
 * headers always win.
 *
 * Useful when you want to point a non-Anthropic-SDK consumer (a raw
 * `fetch` call, the Vercel AI SDK, a custom client) at UncommonRoute
 * without repeating the header wiring at every call site.
 *
 * @example
 * ```ts
 * const fetch = wrapFetch({ routerUrl, sessionId });
 * await fetch(`${routerUrl}/v1/messages`, { method: "POST", body: ... });
 * ```
 */
export function wrapFetch(opts: RouterOptions): FetchLike {
  const base = resolveBaseFetch(opts)
  const defaults: Record<string, string> = sessionHeadersFromOptions(opts)
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) defaults[k] = v
  }

  return async (input, init) => {
    const headers = mergeHeaders(init?.headers, defaults)
    return base(input, { ...init, headers })
  }
}
