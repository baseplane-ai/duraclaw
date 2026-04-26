/**
 * Tests for `getSpecStatus` — the chain planning→implementation
 * precondition resolver. The original bug was a leading-zero filename
 * mismatch (issue 8 spec named `0008-foo.md` was invisible) and a
 * filename-prefix collision (issue 16 matched three unrelated specs).
 * These tests pin the new resolution order:
 *
 *   1. Frontmatter `github_issue: N` is the canonical signal.
 *   2. Filename prefix `^0*N-.*\.md$` is the legacy fallback.
 *   3. When multiple match, latest by mtime wins.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSpecStatus } from './gateway-files'
import type { Env } from './types'

interface SpecFixture {
  name: string
  modified?: string | number
  content?: string
}

interface MockGateway {
  files: SpecFixture[]
}

function withMockGateway(gateway: MockGateway): Env {
  const fetchMock = vi.fn(async (input: Request | URL | string) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    if (url.pathname === '/projects/proj/files') {
      return new Response(
        JSON.stringify({
          entries: gateway.files.map((f) => ({
            name: f.name,
            path: `planning/specs/${f.name}`,
            modified: f.modified ?? '2026-04-01T00:00:00Z',
          })),
        }),
        { status: 200 },
      )
    }
    if (url.pathname.startsWith('/projects/proj/files/')) {
      const rel = decodeURIComponent(url.pathname.replace('/projects/proj/files/', ''))
      const fileName = rel.replace(/^planning\/specs\//, '')
      const file = gateway.files.find((f) => f.name === fileName)
      if (!file || file.content === undefined) return new Response('', { status: 404 })
      return new Response(file.content, { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    CC_GATEWAY_URL: 'https://gw.test',
    CC_GATEWAY_SECRET: 'test',
  } as unknown as Env
}

const fm = (issue: number | null, status: string) => {
  const issueLine = issue === null ? 'github_issue: null' : `github_issue: ${issue}`
  return `---\ninitiative: test\n${issueLine}\nstatus: ${status}\n---\n\nbody\n`
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getSpecStatus — frontmatter resolution (Pass 1)', () => {
  it('matches by frontmatter github_issue regardless of filename', async () => {
    const env = withMockGateway({
      files: [
        { name: '99-unrelated.md', content: fm(99, 'approved') },
        // Filename has nothing to do with issue 42; only frontmatter says so.
        { name: 'something-completely-different.md', content: fm(42, 'approved') },
      ],
    })
    const res = await getSpecStatus(env, 'proj', 42)
    expect(res).toEqual({
      exists: true,
      status: 'approved',
      path: 'planning/specs/something-completely-different.md',
    })
  })

  it('frontmatter match wins over filename match', async () => {
    const env = withMockGateway({
      files: [
        // Filename screams "issue 42" but frontmatter says it's actually 99.
        { name: '42-misnamed.md', content: fm(99, 'approved') },
        // Frontmatter is canonical.
        { name: 'real-spec.md', content: fm(42, 'draft') },
      ],
    })
    const res = await getSpecStatus(env, 'proj', 42)
    expect(res.exists).toBe(true)
    expect(res.path).toBe('planning/specs/real-spec.md')
    expect(res.status).toBe('draft')
  })

  it('picks the latest by mtime when multiple frontmatter matches', async () => {
    const env = withMockGateway({
      files: [
        {
          name: 'spec-old.md',
          modified: '2026-01-01T00:00:00Z',
          content: fm(42, 'draft'),
        },
        {
          name: 'spec-new.md',
          modified: '2026-04-25T00:00:00Z',
          content: fm(42, 'approved'),
        },
      ],
    })
    const res = await getSpecStatus(env, 'proj', 42)
    expect(res.path).toBe('planning/specs/spec-new.md')
    expect(res.status).toBe('approved')
  })

  it('treats numeric coercion: "0042" frontmatter matches issue 42', async () => {
    const env = withMockGateway({
      files: [{ name: 'spec.md', content: fm(42, 'approved').replace('42', '0042') }],
    })
    const res = await getSpecStatus(env, 'proj', 42)
    expect(res.exists).toBe(true)
  })

  it('ignores `github_issue: null` frontmatter', async () => {
    const env = withMockGateway({
      files: [
        // null frontmatter — must NOT be treated as a match for any issue.
        { name: '42-bare.md', content: fm(null, 'approved') },
      ],
    })
    // Should still match via filename fallback (Pass 2), since `42-bare.md`
    // matches the prefix regex.
    const res = await getSpecStatus(env, 'proj', 42)
    expect(res.exists).toBe(true)
    expect(res.path).toBe('planning/specs/42-bare.md')
  })
})

describe('getSpecStatus — filename fallback (Pass 2)', () => {
  it('matches `0008-foo.md` for issue 8 (the original bug)', async () => {
    const env = withMockGateway({
      files: [
        // No github_issue frontmatter — must fall back to filename.
        { name: '0008-yjs-blocknote-realtime-docs-sync.md', content: '---\nstatus: draft\n---\n' },
      ],
    })
    const res = await getSpecStatus(env, 'proj', 8)
    expect(res.exists).toBe(true)
    expect(res.path).toBe('planning/specs/0008-yjs-blocknote-realtime-docs-sync.md')
    expect(res.status).toBe('draft')
  })

  it('matches bare `42-foo.md` for issue 42', async () => {
    const env = withMockGateway({
      files: [{ name: '42-foo.md', content: '---\nstatus: approved\n---\n' }],
    })
    const res = await getSpecStatus(env, 'proj', 42)
    expect(res.exists).toBe(true)
    expect(res.path).toBe('planning/specs/42-foo.md')
  })

  it('does NOT match a partial number prefix (issue 1 must not pick `16-foo.md`)', async () => {
    const env = withMockGateway({
      files: [{ name: '16-foo.md', content: '---\nstatus: approved\n---\n' }],
    })
    const res = await getSpecStatus(env, 'proj', 1)
    expect(res.exists).toBe(false)
  })

  it('frontmatter pool wins even when filename pool also has matches', async () => {
    const env = withMockGateway({
      files: [
        // Filename match, but frontmatter says issue 99.
        { name: '42-old.md', content: fm(99, 'approved') },
        // Frontmatter match, filename irrelevant.
        { name: 'canonical-42.md', content: fm(42, 'approved') },
      ],
    })
    const res = await getSpecStatus(env, 'proj', 42)
    expect(res.path).toBe('planning/specs/canonical-42.md')
  })
})

describe('getSpecStatus — empty / missing', () => {
  it('returns {exists:false} when planning/specs is empty', async () => {
    const env = withMockGateway({ files: [] })
    const res = await getSpecStatus(env, 'proj', 42)
    expect(res).toEqual({ exists: false, status: null, path: null })
  })

  it('returns {exists:false} when no spec mentions the issue', async () => {
    const env = withMockGateway({
      files: [
        { name: '99-other.md', content: fm(99, 'approved') },
        { name: '0017-other.md', content: '---\nstatus: draft\n---\n' },
      ],
    })
    const res = await getSpecStatus(env, 'proj', 42)
    expect(res).toEqual({ exists: false, status: null, path: null })
  })

  it('returns {exists:false} when CC_GATEWAY_URL is unset', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const env = {} as Env
    const res = await getSpecStatus(env, 'proj', 42)
    expect(res.exists).toBe(false)
  })
})
