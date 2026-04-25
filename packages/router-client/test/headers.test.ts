import { describe, expect, it } from 'vitest'
import { hasRouteMetadata, parseRouteHeaders } from '../src/headers.js'

const RICH_HEADERS: Record<string, string> = {
  'x-uncommon-route-mode': 'auto',
  'x-uncommon-route-request-id': 'req-42',
  'x-uncommon-route-model': 'claude-sonnet-4-6',
  'x-uncommon-route-tier': 'MEDIUM',
  'x-uncommon-route-decision-tier': 'HARD',
  'x-uncommon-route-step': 'general',
  'x-uncommon-route-input-before': '1024',
  'x-uncommon-route-input-after': '256',
  'x-uncommon-route-artifacts': '2',
  'x-uncommon-route-transport': 'anthropic',
  'x-uncommon-route-cache-mode': 'prompt_cache_key',
  'x-uncommon-route-cache-family': 'claude',
  'x-uncommon-route-cache-breakpoints': '3',
  'x-uncommon-route-cache-key': 'abc123',
  'x-uncommon-route-semantic-calls': '4',
  'x-uncommon-route-semantic-fallbacks': '1',
  'x-uncommon-route-checkpoints': '1',
  'x-uncommon-route-rehydrated': '0',
}

describe('parseRouteHeaders', () => {
  it('parses every field from a WHATWG Headers object', () => {
    const h = new Headers(RICH_HEADERS)
    const meta = parseRouteHeaders(h)

    expect(meta.mode).toBe('auto')
    expect(meta.requestId).toBe('req-42')
    expect(meta.model).toBe('claude-sonnet-4-6')
    expect(meta.tier).toBe('MEDIUM')
    expect(meta.decisionTier).toBe('HARD')
    expect(meta.step).toBe('general')
    expect(meta.inputTokensBefore).toBe(1024)
    expect(meta.inputTokensAfter).toBe(256)
    expect(meta.artifacts).toBe(2)
    expect(meta.transport).toBe('anthropic')
    expect(meta.cacheMode).toBe('prompt_cache_key')
    expect(meta.cacheFamily).toBe('claude')
    expect(meta.cacheBreakpoints).toBe(3)
    expect(meta.cacheKey).toBe('abc123')
    expect(meta.semanticCalls).toBe(4)
    expect(meta.semanticFallbacks).toBe(1)
    expect(meta.checkpoints).toBe(1)
    expect(meta.rehydrated).toBe(0)
  })

  it('parses plain-object headers case-insensitively', () => {
    const meta = parseRouteHeaders({
      'X-Uncommon-Route-Mode': 'auto',
      'X-UNCOMMON-ROUTE-MODEL': 'gpt-5',
      'x-uncommon-route-tier': 'EASY',
    })
    expect(meta.mode).toBe('auto')
    expect(meta.model).toBe('gpt-5')
    expect(meta.tier).toBe('EASY')
  })

  it('returns nulls for missing fields', () => {
    const meta = parseRouteHeaders(new Headers())
    expect(meta.mode).toBeNull()
    expect(meta.model).toBeNull()
    expect(meta.inputTokensBefore).toBeNull()
    expect(meta.cacheBreakpoints).toBeNull()
  })

  it('treats malformed integer headers as null', () => {
    const meta = parseRouteHeaders(new Headers({ 'x-uncommon-route-input-before': 'not-a-number' }))
    expect(meta.inputTokensBefore).toBeNull()
  })

  it('handles string[] values in plain objects (first value wins)', () => {
    const meta = parseRouteHeaders({
      'x-uncommon-route-model': ['claude-sonnet-4-6', 'shadow-copy'],
    })
    expect(meta.model).toBe('claude-sonnet-4-6')
  })

  it('supports a `.get()`-only header container', () => {
    const bag: Record<string, string> = RICH_HEADERS
    const container = {
      get(name: string): string | null {
        return bag[name.toLowerCase()] ?? null
      },
    }
    const meta = parseRouteHeaders(container)
    expect(meta.model).toBe('claude-sonnet-4-6')
    expect(meta.tier).toBe('MEDIUM')
  })
})

describe('hasRouteMetadata', () => {
  it('detects any x-uncommon-route-* header in a Headers object', () => {
    const h = new Headers({ 'x-uncommon-route-mode': 'auto' })
    expect(hasRouteMetadata(h)).toBe(true)
  })

  it('returns false when no uncommon-route headers are present', () => {
    expect(hasRouteMetadata(new Headers({ 'content-type': 'application/json' }))).toBe(false)
  })

  it('detects uncommon-route headers on a plain object', () => {
    expect(hasRouteMetadata({ 'X-Uncommon-Route-Model': 'claude' })).toBe(true)
    expect(hasRouteMetadata({ 'x-request-id': 'other' })).toBe(false)
  })
})
