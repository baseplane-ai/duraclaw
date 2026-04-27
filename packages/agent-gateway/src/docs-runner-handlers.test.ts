import fs from 'node:fs/promises'
import os from 'node:os'
import nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleDocsRunnerStatus,
  handleListDocsRunners,
  handleStartDocsRunner,
  type StatFn,
} from './docs-runner-handlers.js'
import type { SpawnFn } from './handlers.js'
import type { LivenessCheck } from './session-state.js'

// ────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ────────────────────────────────────────────────────────────────────

let tmpDir: string
let originalWorkerUrl: string | undefined
let originalProjectPatterns: string | undefined
let originalWorktreePatterns: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'duraclaw-docs-test-'))
  originalWorkerUrl = process.env.WORKER_PUBLIC_URL
  originalProjectPatterns = process.env.PROJECT_PATTERNS
  originalWorktreePatterns = process.env.WORKTREE_PATTERNS
  process.env.WORKER_PUBLIC_URL = 'https://example.com'
  process.env.PROJECT_PATTERNS = 'duraclaw'
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
  if (originalWorkerUrl === undefined) delete process.env.WORKER_PUBLIC_URL
  else process.env.WORKER_PUBLIC_URL = originalWorkerUrl
  if (originalProjectPatterns === undefined) delete process.env.PROJECT_PATTERNS
  else process.env.PROJECT_PATTERNS = originalProjectPatterns
  if (originalWorktreePatterns === undefined) delete process.env.WORKTREE_PATTERNS
  else process.env.WORKTREE_PATTERNS = originalWorktreePatterns
  vi.restoreAllMocks()
})

function mkSpawnSpy(): { fn: SpawnFn; calls: { bin: string; args: string[]; opts: unknown }[] } {
  const calls: { bin: string; args: string[]; opts: unknown }[] = []
  const fn: SpawnFn = (bin, args, opts) => {
    calls.push({ bin, args, opts })
    return {
      unref: () => {},
      pid: 99999,
    }
  }
  return { fn, calls }
}

/** Stat fn that pretends `/data/projects/duraclaw` (and its subdirs) exist. */
const fakeProjectsStat: StatFn = async (p) => {
  if (p === '/data/projects/duraclaw' || p.startsWith('/data/projects/duraclaw/')) {
    return { isDirectory: () => true }
  }
  if (p === '/etc') {
    return { isDirectory: () => true }
  }
  return null
}

const PROJECT_ID = '0123456789abcdef'

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: PROJECT_ID,
    docsWorktreePath: '/data/projects/duraclaw',
    bearer: 'test-bearer-123',
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────────────
// POST /docs-runners/start
// ────────────────────────────────────────────────────────────────────

describe('POST /docs-runners/start', () => {
  it('accepts a valid body, writes cmd file, spawns detached docs-runner', async () => {
    const spy = mkSpawnSpy()
    const unrefSpy = vi.fn()
    const spawnFn: SpawnFn = (bin, args, opts) => {
      spy.fn(bin, args, opts)
      return { unref: unrefSpy, pid: 12345 }
    }

    const resp = await handleStartDocsRunner(validBody(), {
      docsRunnersDir: tmpDir,
      binResolver: async () => '/fake/bin/docs-runner',
      spawnFn,
      statFn: fakeProjectsStat,
    })

    expect(resp.status).toBe(202)
    const body = (await resp.json()) as { ok: boolean; pidFile: string; cmdFile: string }
    expect(body.ok).toBe(true)
    expect(body.cmdFile).toBe(nodePath.join(tmpDir, `${PROJECT_ID}.cmd`))
    expect(body.pidFile).toBe(nodePath.join(tmpDir, `${PROJECT_ID}.pid`))

    // Cmd file persisted with the DocsRunnerCommand JSON shape
    const cmdContent = await fs.readFile(nodePath.join(tmpDir, `${PROJECT_ID}.cmd`), 'utf8')
    expect(JSON.parse(cmdContent)).toEqual({
      type: 'docs-runner',
      projectId: PROJECT_ID,
      docsWorktreePath: '/data/projects/duraclaw',
      callbackBase: 'wss://example.com/parties/repo-document',
      bearer: 'test-bearer-123',
    })

    // Spawn argv (5 positional, per docs-runner/src/main.ts):
    // [projectId, cmdFile, pidFile, exitFile, metaFile]
    expect(spy.calls).toHaveLength(1)
    const call = spy.calls[0]
    expect(call.bin).toBe('/fake/bin/docs-runner')
    expect(call.args).toEqual([
      PROJECT_ID,
      nodePath.join(tmpDir, `${PROJECT_ID}.cmd`),
      nodePath.join(tmpDir, `${PROJECT_ID}.pid`),
      nodePath.join(tmpDir, `${PROJECT_ID}.exit`),
      nodePath.join(tmpDir, `${PROJECT_ID}.meta.json`),
    ])

    // Detached + stdio inherits log fd + unref called
    const opts = call.opts as {
      stdio: unknown[]
      detached: boolean
      env: Record<string, string>
    }
    expect(opts.detached).toBe(true)
    expect(opts.stdio[0]).toBe('ignore')
    expect(typeof opts.stdio[1]).toBe('number')
    expect(opts.stdio[1]).toBe(opts.stdio[2])
    expect(opts.env.DOCS_RUNNERS_DIR).toBe(tmpDir)
    expect(unrefSpy).toHaveBeenCalledTimes(1)
  })

  it('400 "invalid body" on bad projectId (not 16-char hex)', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartDocsRunner(validBody({ projectId: 'not-hex' }), {
      docsRunnersDir: tmpDir,
      binResolver: async () => '/x',
      spawnFn,
      statFn: fakeProjectsStat,
    })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'invalid body' })
  })

  it('400 "invalid body" on missing docsWorktreePath', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartDocsRunner(validBody({ docsWorktreePath: undefined }), {
      docsRunnersDir: tmpDir,
      binResolver: async () => '/x',
      spawnFn,
      statFn: fakeProjectsStat,
    })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'invalid body' })
  })

  it('400 "docs_worktree_invalid" when path is /etc (outside /data/projects)', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartDocsRunner(validBody({ docsWorktreePath: '/etc' }), {
      docsRunnersDir: tmpDir,
      binResolver: async () => '/x',
      spawnFn,
      statFn: fakeProjectsStat,
    })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'docs_worktree_invalid' })
  })

  it('400 "docs_worktree_invalid" when path does not exist', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartDocsRunner(
      validBody({ docsWorktreePath: '/data/projects/duraclaw/missing' }),
      {
        docsRunnersDir: tmpDir,
        binResolver: async () => '/x',
        spawnFn,
        // statFn returns null for any path not explicitly known
        statFn: async () => null,
      },
    )
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'docs_worktree_invalid' })
  })

  it('500 "worker_public_url_unset" when WORKER_PUBLIC_URL is missing', async () => {
    delete process.env.WORKER_PUBLIC_URL
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartDocsRunner(validBody(), {
      docsRunnersDir: tmpDir,
      binResolver: async () => '/fake/bin/docs-runner',
      spawnFn,
      statFn: fakeProjectsStat,
    })
    expect(resp.status).toBe(500)
    expect(await resp.json()).toEqual({ ok: false, error: 'worker_public_url_unset' })
  })

  it('idempotent: pre-existing live pid → 200 already_running, no spawn', async () => {
    await fs.writeFile(
      nodePath.join(tmpDir, `${PROJECT_ID}.pid`),
      JSON.stringify({ pid: 12345, projectId: PROJECT_ID, started_at: 1 }),
    )
    const spy = mkSpawnSpy()
    const isAlive: LivenessCheck = (pid) => pid === 12345

    const resp = await handleStartDocsRunner(validBody(), {
      docsRunnersDir: tmpDir,
      binResolver: async () => '/fake/bin/docs-runner',
      spawnFn: spy.fn,
      statFn: fakeProjectsStat,
      isAlive,
    })

    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ ok: true, already_running: true, pid: 12345 })
    // No spawn happened
    expect(spy.calls).toHaveLength(0)
  })

  it('dead pid: re-spawns, returns 202', async () => {
    await fs.writeFile(
      nodePath.join(tmpDir, `${PROJECT_ID}.pid`),
      JSON.stringify({ pid: 99999, projectId: PROJECT_ID, started_at: 1 }),
    )
    const spy = mkSpawnSpy()
    const isAlive: LivenessCheck = () => false

    const resp = await handleStartDocsRunner(validBody(), {
      docsRunnersDir: tmpDir,
      binResolver: async () => '/fake/bin/docs-runner',
      spawnFn: spy.fn,
      statFn: fakeProjectsStat,
      isAlive,
    })

    expect(resp.status).toBe(202)
    expect(spy.calls).toHaveLength(1)
  })
})

// ────────────────────────────────────────────────────────────────────
// GET /docs-runners
// ────────────────────────────────────────────────────────────────────

describe('GET /docs-runners', () => {
  it('returns empty array when dir missing', async () => {
    const missingDir = nodePath.join(tmpDir, 'does-not-exist')
    const resp = await handleListDocsRunners({ docsRunnersDir: missingDir })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ ok: true, runners: [] })
  })

  it('returns empty array when dir has no .pid files', async () => {
    const resp = await handleListDocsRunners({ docsRunnersDir: tmpDir })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ ok: true, runners: [] })
  })

  it('returns one snapshot for one pid file present', async () => {
    await fs.writeFile(
      nodePath.join(tmpDir, `${PROJECT_ID}.pid`),
      JSON.stringify({ pid: 100, projectId: PROJECT_ID, started_at: 1 }),
    )
    const isAlive: LivenessCheck = (pid) => pid === 100

    const resp = await handleListDocsRunners({ docsRunnersDir: tmpDir, isAlive })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as {
      ok: boolean
      runners: Array<{ session_id: string; state: string }>
    }
    expect(body.ok).toBe(true)
    expect(body.runners).toHaveLength(1)
    expect(body.runners[0].session_id).toBe(PROJECT_ID)
    expect(body.runners[0].state).toBe('running')
  })
})

// ────────────────────────────────────────────────────────────────────
// GET /docs-runners/:projectId/status
// ────────────────────────────────────────────────────────────────────

describe('GET /docs-runners/:projectId/status', () => {
  it('400 on bad projectId (not 16-char hex)', async () => {
    const resp = await handleDocsRunnerStatus('not-hex', { docsRunnersDir: tmpDir })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'invalid projectId' })
  })

  it('404 when neither pid nor exit file exists', async () => {
    const resp = await handleDocsRunnerStatus(PROJECT_ID, { docsRunnersDir: tmpDir })
    expect(resp.status).toBe(404)
    expect(await resp.json()).toEqual({ ok: false, error: 'docs runner not found' })
  })

  it('200 state:"running" on live pid', async () => {
    await fs.writeFile(
      nodePath.join(tmpDir, `${PROJECT_ID}.pid`),
      JSON.stringify({ pid: 42, projectId: PROJECT_ID, started_at: 1 }),
    )
    const isAlive: LivenessCheck = (pid) => pid === 42

    const resp = await handleDocsRunnerStatus(PROJECT_ID, {
      docsRunnersDir: tmpDir,
      isAlive,
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.state).toBe('running')
    expect(body.session_id).toBe(PROJECT_ID)
  })
})
