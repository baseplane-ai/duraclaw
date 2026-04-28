import './jsdom-bootstrap.js'

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { markdownToYDoc, yDocToMarkdown } from './blocknote-bridge.js'
import { HashStore, hashOfNormalisedMarkdown } from './content-hash.js'
import { reconcileOnAttach } from './reconcile.js'
import { SuppressedWriter } from './writer.js'

async function seedDisk(rootPath: string, relPath: string, contents: string): Promise<void> {
  const abs = resolve(rootPath, relPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, contents)
}

describe('reconcileOnAttach', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'duraclaw-docs-reconcile-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('Case A — diskHash matches lastCommittedHash; DO authoritative', async () => {
    const rel = 'note.md'
    const md = '# hello world\n\nbody paragraph.\n'

    // Pre-seed disk and Y.Doc with the same content.
    await seedDisk(dir, rel, md)
    const ydoc = new Y.Doc()
    await markdownToYDoc(md, ydoc)

    // Pre-seed hash store with the canonical hash.
    const hashStore = new HashStore(dir)
    await hashStore.load()
    const canonicalHash = await hashOfNormalisedMarkdown(md)
    await hashStore.set(rel, canonicalHash)

    const writer = new SuppressedWriter(dir)
    const result = await reconcileOnAttach({
      rootPath: dir,
      relPath: rel,
      ydoc,
      hashStore,
      writer,
    })

    expect(result.case).toBe('A')
    expect(result.diskHash).toBe(canonicalHash)

    // Disk should be readable and equivalent (post-write hash matches what
    // the DO Y.Doc round-trips to).
    const onDisk = await readFile(resolve(dir, rel), 'utf8')
    const expectedDoMd = await yDocToMarkdown(ydoc)
    expect(onDisk).toBe(expectedDoMd)
    expect(hashStore.get(rel)).toBe(await hashOfNormalisedMarkdown(expectedDoMd))

    // B9 invariant: writer added a suppress entry for the path it wrote.
    expect(writer.isSuppressed(resolve(dir, rel))).toBe(true)
  })

  it('Case B — disk differs from lastCommittedHash; DO empty; seeds Y.Doc from disk', async () => {
    const rel = 'seed.md'
    const md = '# from disk\n\nseed content.\n'

    await seedDisk(dir, rel, md)
    const ydoc = new Y.Doc() // empty
    const hashStore = new HashStore(dir)
    await hashStore.load() // empty
    const writer = new SuppressedWriter(dir)

    const beforeDisk = await readFile(resolve(dir, rel), 'utf8')

    const result = await reconcileOnAttach({
      rootPath: dir,
      relPath: rel,
      ydoc,
      hashStore,
      writer,
    })

    expect(result.case).toBe('B')

    // Y.Doc now holds the disk seed.
    const ydocMd = await yDocToMarkdown(ydoc)
    expect(ydocMd).toContain('from disk')

    // Disk content was NOT touched — Case B is push-only.
    const afterDisk = await readFile(resolve(dir, rel), 'utf8')
    expect(afterDisk).toBe(beforeDisk)

    // Hash store records the post-seed canonical hash.
    expect(hashStore.get(rel)).toBe(await hashOfNormalisedMarkdown(ydocMd))

    // No write happened in Case B, so no suppress entry was added by the
    // writer for this path. The B9 invariant only applies to the cases
    // that go through `writer.write` — A, C, and 'no-disk-do-content'.
    expect(writer.isSuppressed(resolve(dir, rel))).toBe(false)
  })

  it('Case C — both sides diverged; merges disk into Y.Doc and rewrites disk', async () => {
    const rel = 'merge.md'
    const diskMd = '# version A\n\nfrom disk only.\n'
    const doMd = '# version B\n\nfrom DO only.\n'

    await seedDisk(dir, rel, diskMd)

    const ydoc = new Y.Doc()
    await markdownToYDoc(doMd, ydoc)

    // Pre-seed a STALE hash that doesn't match the disk content.
    const hashStore = new HashStore(dir)
    await hashStore.load()
    await hashStore.set(rel, 'f'.repeat(64))

    const writer = new SuppressedWriter(dir)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await reconcileOnAttach({
      rootPath: dir,
      relPath: rel,
      ydoc,
      hashStore,
      writer,
    })

    expect(result.case).toBe('C')

    // Y.Doc now non-empty (it always was) and contains merged blocks.
    const mergedMd = await yDocToMarkdown(ydoc)
    expect(mergedMd.trim()).not.toBe('')

    // Disk now matches the post-merge Y.Doc serialisation.
    const onDisk = await readFile(resolve(dir, rel), 'utf8')
    expect(onDisk).toBe(mergedMd)

    // Hash store updated to the new post-merge hash.
    expect(hashStore.get(rel)).toBe(await hashOfNormalisedMarkdown(mergedMd))

    // Operator-audit warn fired with both hashes.
    expect(warnSpy).toHaveBeenCalled()
    const warnArg = String(warnSpy.mock.calls[0]?.[0] ?? '')
    expect(warnArg).toContain('[reconcile] merge')
    expect(warnArg).toContain(rel)

    // B9 invariant: writer added a suppress entry for the rewritten path.
    expect(writer.isSuppressed(resolve(dir, rel))).toBe(true)
  })

  it('no-disk-do-empty — clears any stale hash entry; no disk write', async () => {
    const rel = 'gone.md'

    const ydoc = new Y.Doc() // empty
    const hashStore = new HashStore(dir)
    await hashStore.load()
    // Seed a stale hash; reconcile should clear it.
    await hashStore.set(rel, 'a'.repeat(64))
    const writer = new SuppressedWriter(dir)

    const result = await reconcileOnAttach({
      rootPath: dir,
      relPath: rel,
      ydoc,
      hashStore,
      writer,
    })

    expect(result.case).toBe('no-disk-do-empty')
    expect(hashStore.get(rel)).toBeUndefined()

    // No write happened — no suppress entry exists.
    expect(writer.isSuppressed(resolve(dir, rel))).toBe(false)

    // Disk file still does not exist.
    await expect(readFile(resolve(dir, rel), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('no-disk-do-content — writes DO content to disk as a new file', async () => {
    const rel = 'fresh.md'
    const doMd = '# created in browser\n\nnewborn doc.\n'

    const ydoc = new Y.Doc()
    await markdownToYDoc(doMd, ydoc)

    const hashStore = new HashStore(dir)
    await hashStore.load()
    const writer = new SuppressedWriter(dir)

    const result = await reconcileOnAttach({
      rootPath: dir,
      relPath: rel,
      ydoc,
      hashStore,
      writer,
    })

    expect(result.case).toBe('no-disk-do-content')

    const onDisk = await readFile(resolve(dir, rel), 'utf8')
    const expectedDoMd = await yDocToMarkdown(ydoc)
    expect(onDisk).toBe(expectedDoMd)

    expect(hashStore.get(rel)).toBe(await hashOfNormalisedMarkdown(expectedDoMd))

    // B9 invariant: writer added a suppress entry for the new file.
    expect(writer.isSuppressed(resolve(dir, rel))).toBe(true)
  })
})
