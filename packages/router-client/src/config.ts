import { wrapFetch } from './fetch.js'
import { sessionHeadersFromOptions } from './session-headers.js'
import type { FetchLike, RouterOptions } from './types.js'

/**
 * Return value of {@link routerConfig}: a pre-built config object that
 * plugs straight into an Anthropic/OpenAI/Claude-Agent SDK constructor (or
 * any client that accepts `baseURL`, `defaultHeaders`, and `fetch`).
 */
export interface RouterConfig {
  /** Normalised router base URL, e.g. `http://127.0.0.1:8403`. */
  baseURL: string
  /** Headers the SDK should merge into every request. */
  defaultHeaders: Record<string, string>
  /** Fetch wrapped to propagate UncommonRoute headers on every call. */
  fetch: FetchLike
}

function normaliseBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) {
    throw new TypeError('@duraclaw/router-client: `routerUrl` cannot be empty.')
  }
  try {
    new URL(trimmed)
  } catch {
    throw new TypeError(`@duraclaw/router-client: \`routerUrl\` must be a valid URL, got: ${url}`)
  }
  return trimmed
}

function buildHeaders(opts: RouterOptions): Record<string, string> {
  const headers: Record<string, string> = sessionHeadersFromOptions(opts)
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) headers[k] = v
  }
  return headers
}

/**
 * Build the config blob most SDKs accept — `{ baseURL, defaultHeaders, fetch }`
 * — pre-pointed at an UncommonRoute proxy and pre-populated with the
 * headers the router expects.
 *
 * @example Claude Agent SDK (Duraclaw session-runner)
 * ```ts
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { routerConfig } from "@duraclaw/router-client";
 *
 * const cfg = routerConfig({
 *   routerUrl: process.env.UNCOMMON_ROUTE_URL!,
 *   sessionId: sessionId,
 * });
 *
 * for await (const ev of query({
 *   prompt,
 *   options: { fetch: cfg.fetch, baseURL: cfg.baseURL },
 * })) {
 *   // ...
 * }
 * ```
 *
 * @example Anthropic SDK
 * ```ts
 * import Anthropic from "@anthropic-ai/sdk";
 * import { routerConfig } from "@duraclaw/router-client";
 *
 * const client = new Anthropic({
 *   ...routerConfig({ routerUrl, sessionId }),
 * });
 * ```
 *
 * @example OpenAI SDK
 * ```ts
 * import OpenAI from "openai";
 * import { routerConfig } from "@duraclaw/router-client";
 *
 * const client = new OpenAI({
 *   apiKey: process.env.OPENAI_API_KEY,
 *   ...routerConfig({ routerUrl, sessionId }),
 * });
 * ```
 */
export function routerConfig(opts: RouterOptions): RouterConfig {
  const baseURL = normaliseBaseUrl(opts.routerUrl)
  const defaultHeaders = buildHeaders(opts)
  const fetch = wrapFetch({ ...opts, routerUrl: baseURL })
  return { baseURL, defaultHeaders, fetch }
}
