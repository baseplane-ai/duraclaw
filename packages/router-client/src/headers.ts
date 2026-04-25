import type { RouteMetadata } from './types.js'

/**
 * Common shape exposed by fetch `Response.headers`, Anthropic/OpenAI SDK
 * response envelopes, and plain objects.
 */
export type HeadersLike =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null }

const HEADER_PREFIX = 'x-uncommon-route-'

function readHeader(headers: HeadersLike, name: string): string | null {
  // Standard Headers / SDK wrappers expose a case-insensitive `.get()`.
  if (typeof (headers as Headers).get === 'function') {
    const v = (headers as Headers).get(name)
    return v == null ? null : v
  }
  // Plain-object fallback: scan case-insensitively.
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(
    headers as Record<string, string | string[] | undefined>,
  )) {
    if (key.toLowerCase() !== lower) continue
    if (value == null) return null
    return Array.isArray(value) ? (value[0] ?? null) : value
  }
  return null
}

function readInt(headers: HeadersLike, name: string): number | null {
  const raw = readHeader(headers, name)
  if (raw == null || raw === '') return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse the `x-uncommon-route-*` response headers the proxy stamps on every
 * routed response into a typed {@link RouteMetadata} record.
 *
 * Missing headers become `null` rather than throwing — the proxy may skip
 * some fields on passthrough.
 */
export function parseRouteHeaders(headers: HeadersLike): RouteMetadata {
  return {
    mode: readHeader(headers, `${HEADER_PREFIX}mode`),
    requestId: readHeader(headers, `${HEADER_PREFIX}request-id`),
    model: readHeader(headers, `${HEADER_PREFIX}model`),
    tier: readHeader(headers, `${HEADER_PREFIX}tier`),
    decisionTier: readHeader(headers, `${HEADER_PREFIX}decision-tier`),
    step: readHeader(headers, `${HEADER_PREFIX}step`),
    inputTokensBefore: readInt(headers, `${HEADER_PREFIX}input-before`),
    inputTokensAfter: readInt(headers, `${HEADER_PREFIX}input-after`),
    artifacts: readInt(headers, `${HEADER_PREFIX}artifacts`),
    transport: readHeader(headers, `${HEADER_PREFIX}transport`),
    cacheMode: readHeader(headers, `${HEADER_PREFIX}cache-mode`),
    cacheFamily: readHeader(headers, `${HEADER_PREFIX}cache-family`),
    cacheBreakpoints: readInt(headers, `${HEADER_PREFIX}cache-breakpoints`),
    cacheKey: readHeader(headers, `${HEADER_PREFIX}cache-key`),
    semanticCalls: readInt(headers, `${HEADER_PREFIX}semantic-calls`),
    semanticFallbacks: readInt(headers, `${HEADER_PREFIX}semantic-fallbacks`),
    checkpoints: readInt(headers, `${HEADER_PREFIX}checkpoints`),
    rehydrated: readInt(headers, `${HEADER_PREFIX}rehydrated`),
  }
}

/** Returns `true` if *any* `x-uncommon-route-*` header is present. */
export function hasRouteMetadata(headers: HeadersLike): boolean {
  if (typeof (headers as Headers).forEach === 'function') {
    let found = false
    ;(headers as Headers).forEach((_value, key) => {
      if (key.toLowerCase().startsWith(HEADER_PREFIX)) found = true
    })
    return found
  }
  for (const key of Object.keys(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase().startsWith(HEADER_PREFIX)) return true
  }
  return false
}
