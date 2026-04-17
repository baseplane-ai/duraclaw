/**
 * Lifecycle integration test for the built session-runner binary.
 *
 * This test verifies the file-lifecycle contract in B3 (pid/meta/exit files)
 * without depending on a real WebSocket listener.
 *
 * Design notes:
 * - The test spawns the *built* `dist/main.js` via `bun` and passes a callback
 *   URL that nobody is listening on. `DialBackClient` retries forever, but
 *   the meta-dumper interval runs independently of WS state — so we can still
 *   assert on pid/meta/exit file behavior.
 * - The spawned runner will also try to resolve the `project` argument via
 *   the SDK, which will fail quickly (no valid project in this sandbox).
 *   That's fine: the test is asserting lifecycle-file behavior, not SDK
 *   success. The SIGTERM path is the primary happy-path we care about.
 * - We set a 20s test timeout to leave headroom for CI.
 * - Skipped when `SKIP_SPAWN_TESTS=1` for environments that can't spawn bun.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const skipSpawn = process.env.SKIP_SPAWN_TESTS === '1'
const test = skipSpawn ? it.skip : it

const THIS_FILE = fileURLToPath(import.meta.url)
const PKG_ROOT = path.resolve(path.dirname(THIS_FILE), '..')
const MAIN_JS = path.join(PKG_ROOT, 'dist', 'main.js')

async function waitFor<T>(
  probe: () => Promise<T | null>,
  opts: { timeoutMs: number; pollMs?: number },
): Promise<T> {
  const pollMs = opts.pollMs ?? 50
  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    const v = await probe()
    if (v !== null) return v
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(`waitFor timed out after ${opts.timeoutMs}ms`)
}

describe('session-runner main.ts — file lifecycle', () => {
  let tmpDir = ''
  let proc: ChildProcessWithoutNullStreams | null = null

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-runner-test-'))
  })

  afterEach(async () => {
    if (proc && proc.exitCode === null) {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    proc = null
    if (tmpDir) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })

  test('writes pid within 1s, meta within 12s, and aborted exit-file within 3s of SIGTERM', async () => {
    // Require the built binary — the whole test is pointless otherwise.
    if (!existsSync(MAIN_JS)) {
      throw new Error(
        `dist/main.js missing at ${MAIN_JS} — run \`pnpm --filter @duraclaw/session-runner build\` first`,
      )
    }

    const sessionId = 'test-session-abc'
    const cmdFile = path.join(tmpDir, `${sessionId}.cmd`)
    const pidFile = path.join(tmpDir, `${sessionId}.pid`)
    const exitFile = path.join(tmpDir, `${sessionId}.exit`)
    const metaFile = path.join(tmpDir, `${sessionId}.meta.json`)

    await fs.writeFile(
      cmdFile,
      JSON.stringify({
        type: 'execute',
        agent: 'claude',
        project: 'duraclaw',
        prompt: 'echo hi',
      }),
    )

    // Spawn the runner. Use a callback URL that nobody is listening on —
    // DialBackClient will retry, but the meta-dumper runs independently.
    // Use a high, unused port range (> 60000) to minimize collision odds.
    proc = spawn(
      'bun',
      [
        MAIN_JS,
        sessionId,
        cmdFile,
        'ws://127.0.0.1:65533/cb',
        'dummy-bearer',
        pidFile,
        exitFile,
        metaFile,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    )
    const pid = proc.pid
    if (!pid) throw new Error('failed to spawn session-runner')

    // Capture stdio for debugging if the test fails.
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    proc.stdout.on('data', (d: Buffer) => stdoutChunks.push(d.toString()))
    proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()))

    // Assertion 1: pid-file exists within 1s and contains the spawned pid.
    const pidPayload = await waitFor(
      async () => {
        try {
          const raw = await fs.readFile(pidFile, 'utf8')
          return JSON.parse(raw) as { pid: number; sessionId: string }
        } catch {
          return null
        }
      },
      { timeoutMs: 1000 },
    )
    expect(typeof pidPayload.pid).toBe('number')
    expect(pidPayload.pid).toBe(pid)
    expect(pidPayload.sessionId).toBe(sessionId)

    // Assertion 2: meta-file appears within 12s and has last_activity_ts.
    const metaPayload = await waitFor(
      async () => {
        try {
          const raw = await fs.readFile(metaFile, 'utf8')
          const parsed = JSON.parse(raw) as { last_activity_ts?: unknown }
          if (typeof parsed.last_activity_ts === 'number') return parsed
          return null
        } catch {
          return null
        }
      },
      { timeoutMs: 12_000 },
    )
    expect(typeof (metaPayload as { last_activity_ts: number }).last_activity_ts).toBe('number')

    // Assertion 3: SIGTERM → exit-file within 3s with state=aborted, exit_code=0.
    proc.kill('SIGTERM')

    const exitPayload = await waitFor(
      async () => {
        try {
          const raw = await fs.readFile(exitFile, 'utf8')
          return JSON.parse(raw) as { state?: unknown; exit_code?: unknown }
        } catch {
          return null
        }
      },
      { timeoutMs: 3000 },
    )
    // Either the runner's own finally-block wrote it (state=aborted via
    // ctx.meta.state) or the SIGTERM watchdog wrote it with state=aborted
    // and exit_code=0. Both are acceptable per B3.
    expect(exitPayload.state).toBe('aborted')
    expect(exitPayload.exit_code).toBe(0)

    // Give the process up to 2s to actually exit — then force-kill.
    await new Promise<void>((resolve) => {
      if (proc && proc.exitCode !== null) {
        resolve()
        return
      }
      const t = setTimeout(() => resolve(), 2000)
      proc?.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }, 20_000)
})
