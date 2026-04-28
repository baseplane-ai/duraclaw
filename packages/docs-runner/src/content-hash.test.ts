import './jsdom-bootstrap.js'

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HashStore, hashOfNormalisedMarkdown, sha256Hex } from './content-hash.js'

describe('sha256Hex', () => {
  it('returns the known digest for an empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('returns the known digest for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('hashes Uint8Array equivalently to string for ascii input', () => {
    const stringHash = sha256Hex('hello')
    const bytesHash = sha256Hex(new TextEncoder().encode('hello'))
    expect(stringHash).toBe(bytesHash)
  })
})

describe('hashOfNormalisedMarkdown', () => {
  it('returns a 64-char lowercase hex digest', async () => {
    const hash = await hashOfNormalisedMarkdown('# Hello\n')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns the same hash for cosmetically different bullet styles', async () => {
    // "- foo" and "* foo" are both valid GFM unordered list markers; after
    // BlockNote round-trip they normalise to the same canonical form.
    const dashHash = await hashOfNormalisedMarkdown('- foo\n- bar\n')
    const starHash = await hashOfNormalisedMarkdown('* foo\n* bar\n')
    expect(dashHash).toBe(starHash)
  })

  it('returns different hashes for materially different content', async () => {
    const a = await hashOfNormalisedMarkdown('# Heading A\n')
    const b = await hashOfNormalisedMarkdown('# Heading B\n')
    expect(a).not.toBe(b)
  })
})

describe('HashStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'duraclaw-docs-hashstore-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('load on missing file initialises empty', async () => {
    const store = new HashStore(dir)
    await store.load()
    expect([...store.entries()]).toEqual([])
    expect(store.get('any.md')).toBeUndefined()
  })

  it('round-trips set + reload', async () => {
    const a = new HashStore(dir)
    await a.load()
    await a.set('foo.md', 'a'.repeat(64))
    await a.set('sub/bar.md', 'b'.repeat(64))

    const b = new HashStore(dir)
    await b.load()
    expect(b.get('foo.md')).toBe('a'.repeat(64))
    expect(b.get('sub/bar.md')).toBe('b'.repeat(64))
  })

  it('delete persists across reload', async () => {
    const a = new HashStore(dir)
    await a.load()
    await a.set('foo.md', 'a'.repeat(64))
    await a.set('bar.md', 'b'.repeat(64))
    await a.delete('foo.md')

    const b = new HashStore(dir)
    await b.load()
    expect(b.get('foo.md')).toBeUndefined()
    expect(b.get('bar.md')).toBe('b'.repeat(64))
  })

  it('sequential concurrent sets leave the JSON valid', async () => {
    const store = new HashStore(dir)
    await store.load()
    // Sequential awaits — the spec says serial inside the test, asserting
    // atomicOverwrite never tears the JSON.
    for (let i = 0; i < 20; i++) {
      await store.set(`file-${i}.md`, sha256Hex(`payload-${i}`))
    }

    const raw = await readFile(join(dir, '.duraclaw-docs', 'hashes.json'), 'utf8')
    const parsed = JSON.parse(raw)
    expect(typeof parsed).toBe('object')
    expect(Object.keys(parsed)).toHaveLength(20)
    for (let i = 0; i < 20; i++) {
      expect(parsed[`file-${i}.md`]).toBe(sha256Hex(`payload-${i}`))
    }
  })

  it('treats malformed JSON as empty (warn + continue)', async () => {
    const store = new HashStore(dir)
    // Pre-create a malformed hashes.json
    await store.load() // creates nothing yet
    await store.set('seed.md', 'c'.repeat(64)) // forces directory creation
    const path = join(dir, '.duraclaw-docs', 'hashes.json')
    await rm(path)
    await (await import('node:fs/promises')).writeFile(path, 'not json{{{')

    const reloaded = new HashStore(dir)
    await reloaded.load()
    expect([...reloaded.entries()]).toEqual([])
  })
})
