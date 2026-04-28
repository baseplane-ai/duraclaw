import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Watcher } from './watcher.js'
import { SuppressedWriter } from './writer.js'

const SKIP = process.platform === 'win32'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

describe('Watcher', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'duraclaw-docs-watcher-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it.skipIf(SKIP)(
    'observes add → change → unlink for a tracked .md file',
    async () => {
      const file = join(dir, 'note.md')
      await writeFile(file, 'first\n')

      const adds: string[] = []
      const changes: string[] = []
      const unlinks: string[] = []
      const addReady = deferred<void>()
      const changeReady = deferred<void>()
      const unlinkReady = deferred<void>()

      const writer = new SuppressedWriter(dir)
      const w = new Watcher({
        rootPath: dir,
        patterns: ['**/*.md'],
        writer,
        onAdd: (rel) => {
          adds.push(rel)
          addReady.resolve()
        },
        onChange: (rel) => {
          changes.push(rel)
          changeReady.resolve()
        },
        onUnlink: (rel) => {
          unlinks.push(rel)
          unlinkReady.resolve()
        },
      })

      await w.start()
      await addReady.promise
      expect(adds).toContain('note.md')

      // Trigger a change (writeFile bypasses the writer's suppress map).
      await writeFile(file, 'second\n')
      await changeReady.promise
      expect(changes).toContain('note.md')

      // Trigger an unlink (raw fs op).
      await rm(file)
      await unlinkReady.promise
      expect(unlinks).toContain('note.md')

      await w.stop()
    },
    20_000,
  )

  it.skipIf(SKIP)(
    'short-circuits change events for paths the writer just touched',
    async () => {
      const seedFile = join(dir, 'seed.md')
      await writeFile(seedFile, 'seed\n')

      const changes: string[] = []
      const writer = new SuppressedWriter(dir)
      const w = new Watcher({
        rootPath: dir,
        patterns: ['**/*.md'],
        writer,
        onAdd: () => {},
        onChange: (rel) => changes.push(rel),
        onUnlink: () => {},
      })

      await w.start()
      // Let the initial add settle.
      await sleep(100)

      // Use the writer — this records a suppress entry, then writes.
      await writer.write('seed.md', 'remote-update\n')

      // Give chokidar plenty of time to flush. With debounce of 500ms +
      // pollInterval 100ms, 1500ms is comfortably past the stability window.
      await sleep(1500)

      expect(changes).toEqual([])
      await w.stop()
    },
    20_000,
  )

  it.skipIf(SKIP)(
    'isAlive() reflects status before/after stop',
    async () => {
      const writer = new SuppressedWriter(dir)
      const w = new Watcher({
        rootPath: dir,
        patterns: ['**/*.md'],
        writer,
        onAdd: () => {},
        onChange: () => {},
        onUnlink: () => {},
      })

      expect(w.isAlive()).toBe(false)
      await w.start()
      expect(w.isAlive()).toBe(true)
      await w.stop()
      expect(w.isAlive()).toBe(false)
    },
    20_000,
  )
})
