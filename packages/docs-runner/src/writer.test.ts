import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SUPPRESS_TTL_MS, SuppressedWriter } from './writer.js'

describe('SuppressedWriter', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'duraclaw-docs-writer-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('write creates the file with the given contents (atomic)', async () => {
    const w = new SuppressedWriter(dir)
    await w.write('hello.md', '# hi\n')
    const contents = await readFile(join(dir, 'hello.md'), 'utf8')
    expect(contents).toBe('# hi\n')
  })

  it('write adds a suppress entry — fresh hit then single-shot consumption', async () => {
    const w = new SuppressedWriter(dir)
    await w.write('hello.md', '# hi\n')
    const abs = resolve(dir, 'hello.md')
    // Fresh entry: first call returns true...
    expect(w.isSuppressed(abs)).toBe(true)
    // ...and is consumed; the next call returns false.
    expect(w.isSuppressed(abs)).toBe(false)
  })

  it('isSuppressed returns false for entries older than SUPPRESS_TTL_MS', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const w = new SuppressedWriter(dir)
    await w.write('hello.md', '# hi\n')
    const abs = resolve(dir, 'hello.md')

    vi.setSystemTime(new Date(Date.now() + SUPPRESS_TTL_MS + 1))
    expect(w.isSuppressed(abs)).toBe(false)
  })

  it('isSuppressed returns false for unknown paths', () => {
    const w = new SuppressedWriter(dir)
    expect(w.isSuppressed(resolve(dir, 'nope.md'))).toBe(false)
  })

  it('unlink removes the file and adds a suppress entry', async () => {
    const w = new SuppressedWriter(dir)
    await w.write('bye.md', 'gone soon\n')
    const abs = resolve(dir, 'bye.md')
    // Consume the suppress from write so the unlink one is unambiguous.
    expect(w.isSuppressed(abs)).toBe(true)

    await w.unlink('bye.md')
    await expect(stat(abs)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(w.isSuppressed(abs)).toBe(true)
  })

  it('unlink is forgiving of already-missing files', async () => {
    const w = new SuppressedWriter(dir)
    await expect(w.unlink('never-existed.md')).resolves.toBeUndefined()
  })

  it('write into a nested path creates parent directories', async () => {
    const w = new SuppressedWriter(dir)
    await w.write('a/b/c/deep.md', 'deep\n')
    const contents = await readFile(join(dir, 'a/b/c/deep.md'), 'utf8')
    expect(contents).toBe('deep\n')
  })
})
