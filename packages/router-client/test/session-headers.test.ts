import { describe, expect, it } from 'vitest'
import { routerConfig } from '../src/config.js'
import { wrapFetch } from '../src/fetch.js'
import { sessionHeadersFromOptions } from '../src/session-headers.js'
import {
  CONTEXT_USAGE_HEADER,
  DIFFICULTY_HINT_HEADER,
  type FetchLike,
  SESSION_BUDGET_HEADER,
  SESSION_HEADER,
  TURN_INDEX_HEADER,
} from '../src/types.js'

describe('sessionHeadersFromOptions', () => {
  it('emits all enrichment headers when set', () => {
    const headers = sessionHeadersFromOptions({
      routerUrl: 'http://127.0.0.1:8403',
      sessionId: 'sess-1',
      turnIndex: 12,
      sessionBudgetUsd: 2.5,
      difficultyHint: 'hard',
      contextUsagePct: 0.83,
    })
    expect(headers[SESSION_HEADER]).toBe('sess-1')
    expect(headers[TURN_INDEX_HEADER]).toBe('12')
    expect(headers[SESSION_BUDGET_HEADER]).toBe('2.5')
    expect(headers[DIFFICULTY_HINT_HEADER]).toBe('hard')
    expect(headers[CONTEXT_USAGE_HEADER]).toBe('0.83')
  })

  it('omits enrichment headers entirely when undefined', () => {
    const headers = sessionHeadersFromOptions({
      routerUrl: 'http://127.0.0.1:8403',
      sessionId: 's',
    })
    expect(headers).not.toHaveProperty(TURN_INDEX_HEADER)
    expect(headers).not.toHaveProperty(SESSION_BUDGET_HEADER)
    expect(headers).not.toHaveProperty(DIFFICULTY_HINT_HEADER)
    expect(headers).not.toHaveProperty(CONTEXT_USAGE_HEADER)
  })

  it('truncates fractional turnIndex to int', () => {
    const headers = sessionHeadersFromOptions({
      routerUrl: 'http://127.0.0.1:8403',
      turnIndex: 7.9,
    })
    expect(headers[TURN_INDEX_HEADER]).toBe('7')
  })

  it('drops non-finite numeric inputs (NaN, Infinity)', () => {
    const headers = sessionHeadersFromOptions({
      routerUrl: 'http://127.0.0.1:8403',
      turnIndex: Number.NaN,
      sessionBudgetUsd: Number.POSITIVE_INFINITY,
      contextUsagePct: Number.NEGATIVE_INFINITY,
    })
    expect(headers).not.toHaveProperty(TURN_INDEX_HEADER)
    expect(headers).not.toHaveProperty(SESSION_BUDGET_HEADER)
    expect(headers).not.toHaveProperty(CONTEXT_USAGE_HEADER)
  })
})

describe('routerConfig propagates enrichment headers', () => {
  it('puts enrichment headers in defaultHeaders', () => {
    const cfg = routerConfig({
      routerUrl: 'http://127.0.0.1:8403',
      sessionId: 'sess-1',
      turnIndex: 5,
      difficultyHint: 'medium',
    })
    expect(cfg.defaultHeaders[TURN_INDEX_HEADER]).toBe('5')
    expect(cfg.defaultHeaders[DIFFICULTY_HINT_HEADER]).toBe('medium')
  })

  it('user `headers` option still wins over enrichment defaults', () => {
    const cfg = routerConfig({
      routerUrl: 'http://127.0.0.1:8403',
      turnIndex: 1,
      headers: { [TURN_INDEX_HEADER]: '99' },
    })
    expect(cfg.defaultHeaders[TURN_INDEX_HEADER]).toBe('99')
  })
})

describe('wrapFetch propagates enrichment headers', () => {
  it('attaches enrichment headers on every call', async () => {
    let captured: Headers | undefined
    const stub: FetchLike = async (_input, init) => {
      captured = new Headers(init?.headers)
      return new Response('ok')
    }
    const fetch = wrapFetch({
      routerUrl: 'http://127.0.0.1:8403',
      sessionId: 'sess-x',
      turnIndex: 3,
      sessionBudgetUsd: 4.0,
      difficultyHint: 'easy',
      contextUsagePct: 0.5,
      fetch: stub,
    })
    await fetch('http://127.0.0.1:8403/v1/messages', { method: 'POST' })

    expect(captured!.get(SESSION_HEADER)).toBe('sess-x')
    expect(captured!.get(TURN_INDEX_HEADER)).toBe('3')
    expect(captured!.get(SESSION_BUDGET_HEADER)).toBe('4')
    expect(captured!.get(DIFFICULTY_HINT_HEADER)).toBe('easy')
    expect(captured!.get(CONTEXT_USAGE_HEADER)).toBe('0.5')
  })

  it('per-call header still wins over wrapped enrichment defaults', async () => {
    let captured: Headers | undefined
    const stub: FetchLike = async (_input, init) => {
      captured = new Headers(init?.headers)
      return new Response('ok')
    }
    const fetch = wrapFetch({
      routerUrl: 'http://127.0.0.1:8403',
      turnIndex: 1,
      fetch: stub,
    })
    await fetch('http://127.0.0.1:8403/v1/messages', {
      method: 'POST',
      headers: { [TURN_INDEX_HEADER]: '99' },
    })
    expect(captured!.get(TURN_INDEX_HEADER)).toBe('99')
  })
})
