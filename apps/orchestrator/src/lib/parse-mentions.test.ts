/**
 * GH#152 P1.5 WU-E — coverage for `parseMentions` (B13).
 *
 * Pure-helper test using the `installFakeDb` chainable stub from
 * `~/api/test-helpers`. parseMentions issues exactly one
 * `.select().from(users).innerJoin(arcMembers, ...).where(...)` chain
 * per call (and skips it when no candidates remain after extraction /
 * de-dupe), so each test queues at most one row-set and asserts the
 * resolved/unresolved partition.
 *
 * The fake stub does NOT understand Drizzle's `eq`/`and`/`or`/`inArray`
 * ops — coverage of the SQL itself belongs in DB-level integration
 * tests. We assert (a) the lowered-token candidate list passed into the
 * resolver and (b) the partition produced from whatever rows the stub
 * returns.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeDb, makeFakeDb } from '~/api/test-helpers'

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import { drizzle } from 'drizzle-orm/d1'
import { parseMentions } from './parse-mentions'

describe('parseMentions', () => {
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  // The drizzle() factory is mocked to return the fake; cast through any
  // so the test surface stays terse.
  const db = () => drizzle({} as any) as any

  it('resolves a simple @alice when alice is an arc member', async () => {
    fakeDb.data.queue = [[{ id: 'user-alice', email: 'alice@example.com', name: 'alice' }]]

    const result = await parseMentions(db(), 'arc-1', 'hey @alice can you look')

    expect(result.resolvedUserIds).toEqual(['user-alice'])
    expect(result.unresolvedTokens).toEqual([])
  })

  it('returns the bare token in unresolvedTokens when no member matches', async () => {
    fakeDb.data.queue = [[]]

    const result = await parseMentions(db(), 'arc-1', 'hey @bob hello')

    expect(result.resolvedUserIds).toEqual([])
    expect(result.unresolvedTokens).toEqual(['bob'])
  })

  it('strips reserved tokens (@everyone @here @channel @all) without a DB call', async () => {
    const result = await parseMentions(db(), 'arc-1', 'cc @everyone, @here come now, @channel @all')

    expect(result.resolvedUserIds).toEqual([])
    expect(result.unresolvedTokens).toEqual([])
    // No queue entry consumed — the impl short-circuits before the JOIN.
    expect(fakeDb.ops).toHaveLength(0)
  })

  it('skips tokens inside a ``` fenced code block', async () => {
    const body = ['outside text — no mentions here', '```', 'use @alice in code', '```'].join('\n')

    const result = await parseMentions(db(), 'arc-1', body)

    expect(result.resolvedUserIds).toEqual([])
    expect(result.unresolvedTokens).toEqual([])
    expect(fakeDb.ops).toHaveLength(0)
  })

  it('skips tokens inside a ~~~ fenced code block', async () => {
    const body = ['plain text', '~~~', '@alice should be ignored', '~~~'].join('\n')

    const result = await parseMentions(db(), 'arc-1', body)

    expect(result.resolvedUserIds).toEqual([])
    expect(result.unresolvedTokens).toEqual([])
    expect(fakeDb.ops).toHaveLength(0)
  })

  it('de-dupes multiple distinct mentions case-insensitively before the DB lookup', async () => {
    // Two of the three tokens are case-variants of the same name; the
    // third resolves to a different user. The resolver should be called
    // once with the de-duped lowercased candidate list.
    fakeDb.data.queue = [
      [
        { id: 'user-alice', email: 'alice@example.com', name: 'alice' },
        { id: 'user-bob', email: 'bob@example.com', name: 'bob' },
      ],
    ]

    const result = await parseMentions(db(), 'arc-1', '@alice @ALICE @bob says hi to @Alice')

    // Each id appears at most once, in token-encounter order (alice first).
    expect(result.resolvedUserIds).toEqual(['user-alice', 'user-bob'])
    expect(result.unresolvedTokens).toEqual([])
  })

  it('does not match @example inside an email address (lookbehind guard)', async () => {
    // The body contains the substring `@example.com` only as part of an
    // email — the `(?<![\w@])` lookbehind on the regex blocks it.
    const result = await parseMentions(db(), 'arc-1', 'send mail to email@example.com please')

    expect(result.resolvedUserIds).toEqual([])
    expect(result.unresolvedTokens).toEqual([])
    expect(fakeDb.ops).toHaveLength(0)
  })

  it('matches @AlIcE case-insensitively against a lowercased member', async () => {
    fakeDb.data.queue = [[{ id: 'user-alice', email: 'alice@example.com', name: 'alice' }]]

    const result = await parseMentions(db(), 'arc-1', 'oh hey @AlIcE')

    expect(result.resolvedUserIds).toEqual(['user-alice'])
    expect(result.unresolvedTokens).toEqual([])
  })

  it('returns empty arrays for an empty body without issuing a DB call', async () => {
    const result = await parseMentions(db(), 'arc-1', '')
    expect(result).toEqual({ resolvedUserIds: [], unresolvedTokens: [] })
    expect(fakeDb.ops).toHaveLength(0)
  })

  it('returns empty arrays for a body with no @ token at all (no DB call)', async () => {
    const result = await parseMentions(db(), 'arc-1', 'no at-signs in this body')
    expect(result).toEqual({ resolvedUserIds: [], unresolvedTokens: [] })
    expect(fakeDb.ops).toHaveLength(0)
  })

  it('does not extract a 1-character token like @a (regex requires {2,32})', async () => {
    const result = await parseMentions(db(), 'arc-1', 'hi @a still here')
    expect(result.resolvedUserIds).toEqual([])
    expect(result.unresolvedTokens).toEqual([])
    expect(fakeDb.ops).toHaveLength(0)
  })

  it('caps token extraction at 32 chars (regex {2,32}) — a 33-char run yields the 32-char prefix as unresolved', async () => {
    // The regex `[a-zA-Z0-9._-]{2,32}` is greedy but capped — feeding it
    // 33 a's yields the first 32 as the captured token. The cap stops
    // unbounded runs from saturating; it does not reject overlong runs
    // outright. The 32-char prefix doesn't match any real user, so it
    // surfaces in unresolvedTokens.
    fakeDb.data.queue = [[]]
    const longToken = 'a'.repeat(33)
    const result = await parseMentions(db(), 'arc-1', `prefix @${longToken} suffix`)
    expect(result.resolvedUserIds).toEqual([])
    expect(result.unresolvedTokens).toEqual(['a'.repeat(32)])
  })
})
