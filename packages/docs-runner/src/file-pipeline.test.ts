import './jsdom-bootstrap.js'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HashStore } from './content-hash.js'
import { FilePipeline, type FilePipelineState } from './file-pipeline.js'
import type { Logger } from './logger.js'
import type { SuppressedWriter } from './writer.js'

/**
 * Tests for P1.9 graceful-shutdown hardening: `stop()` MUST await in-flight
 * watcher-driven writes (tracked via the private `inFlight` set) before
 * tearing down transport / dial-back / ydoc, and MUST honour the 1.5s
 * internal timeout so a runaway writer can't extend past main.ts's 2s
 * SIGTERM watchdog.
 *
 * Strategy: we exercise `onLocalChange()` (which goes through `track()`)
 * while a controlled `hashStore.set` stalls. We never call `start()` —
 * the pipeline does NOT need to be connected to track an in-flight
 * watcher event. The test asserts ordering of stop() vs the stall.
 */

interface DeferredHashStore extends Pick<HashStore, 'get' | 'set' | 'delete'> {
  resolveSet(): void
  setCalled(): boolean
}

function makeDeferredHashStore(): DeferredHashStore {
  let resolver: (() => void) | null = null
  let called = false
  const setPromise = new Promise<void>((resolve) => {
    resolver = resolve
  })
  return {
    get: () => undefined, // force the B8 gate to NOT skip
    set: vi.fn(async () => {
      called = true
      await setPromise
    }) as unknown as HashStore['set'],
    delete: vi.fn(async () => {}) as unknown as HashStore['delete'],
    resolveSet: () => resolver?.(),
    setCalled: () => called,
  }
}

function makeNoopWriter(): SuppressedWriter {
  return {
    write: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    isSuppressed: vi.fn(() => false),
  } as unknown as SuppressedWriter
}

function makeSilentLogger(): Logger & {
  warns: Array<[string, Record<string, unknown> | undefined]>
} {
  const warns: Array<[string, Record<string, unknown> | undefined]> = []
  return {
    debug: () => {},
    info: () => {},
    warn: (event, attrs) => {
      warns.push([event, attrs as Record<string, unknown> | undefined])
    },
    error: () => {},
    warns,
  }
}

describe('FilePipeline.stop() — in-flight write tracking (P1.9)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'duraclaw-fp-shutdown-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('awaits an in-flight tracked operation before tearing down', async () => {
    await writeFile(join(dir, 'note.md'), '# hello\n')

    const hashStore = makeDeferredHashStore()
    const writer = makeNoopWriter()
    const logger = makeSilentLogger()

    const pipeline = new FilePipeline({
      rootPath: dir,
      relPath: 'note.md',
      projectId: 'p',
      callbackBase: 'wss://example.invalid/api/collab/repo-document',
      bearer: 'unused',
      hashStore: hashStore as unknown as HashStore,
      writer,
      // Editor is unused on this code path because hashStore.set hangs
      // before markdownToYDoc is reached.
      editor: {} as never,
      onTerminate: () => {},
      onStateChange: () => {},
      logger,
    })

    // Kick off the write; do NOT await — we want it pending when stop() runs.
    const writePromise = pipeline.onLocalChange()

    // Yield so the read+hashStore.set call actually starts.
    await new Promise((r) => setTimeout(r, 10))
    expect(hashStore.setCalled()).toBe(true)

    let stopResolved = false
    const stopPromise = pipeline.stop().then(() => {
      stopResolved = true
    })

    // stop() must NOT have completed yet — the in-flight write is blocking it.
    await new Promise((r) => setTimeout(r, 50))
    expect(stopResolved).toBe(false)

    // Release the write; stop() should now resolve.
    hashStore.resolveSet()
    await stopPromise
    expect(stopResolved).toBe(true)

    // The pending write also settles.
    await writePromise.catch(() => {})
  })

  it('honours the 1.5s flush timeout when an operation hangs', async () => {
    await writeFile(join(dir, 'slow.md'), '# slow\n')

    const hashStore = makeDeferredHashStore()
    const writer = makeNoopWriter()
    const logger = makeSilentLogger()

    const pipeline = new FilePipeline({
      rootPath: dir,
      relPath: 'slow.md',
      projectId: 'p',
      callbackBase: 'wss://example.invalid/api/collab/repo-document',
      bearer: 'unused',
      hashStore: hashStore as unknown as HashStore,
      writer,
      editor: {} as never,
      onTerminate: () => {},
      onStateChange: () => {},
      logger,
    })

    const writePromise = pipeline.onLocalChange()
    await new Promise((r) => setTimeout(r, 10))
    expect(hashStore.setCalled()).toBe(true)

    const t0 = Date.now()
    // Never resolve hashStore — stop() must time out internally.
    await pipeline.stop()
    const elapsed = Date.now() - t0

    // Allow generous slack for slow CI; the cap is 1.5s. Anything under
    // ~1.9s is correct (within main.ts's 2s SIGTERM watchdog).
    expect(elapsed).toBeGreaterThanOrEqual(1_400)
    expect(elapsed).toBeLessThan(1_950)

    // The timeout must surface a structured warn line.
    const flushWarn = logger.warns.find(([event]) => event === 'shutdown.flush_timeout')
    expect(flushWarn).toBeDefined()
    expect(flushWarn?.[1]).toMatchObject({ file: 'slow.md' })

    // Release the hung write so the in-flight promise can settle (avoids
    // unhandled-rejection noise after the test resolves).
    hashStore.resolveSet()
    await writePromise.catch(() => {})
  }, 5_000)
})

// Reference unused imports to satisfy strict-mode TS without needing
// `// @ts-ignore`. They appear in type positions only.
export type _Unused = FilePipelineState
