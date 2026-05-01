import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import jsYaml from 'js-yaml'
import { clearKataConfigCache } from '../config/kata-config.js'
import type { SessionState } from '../state/schema.js'
import { exit } from './exit.js'

function makeTmpDir(): string {
  const dir = join(
    os.tmpdir(),
    `kata-exit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Capture stdout from `exit()` so the JSON it prints doesn't leak into test output. */
async function runExit(args: string[]): Promise<void> {
  const origLog = console.log
  console.log = () => {}
  try {
    await exit(args)
  } finally {
    console.log = origLog
  }
}

describe('exit — no-mode sentinel', () => {
  let tmpDir: string
  const origEnv = process.env.CLAUDE_PROJECT_DIR

  beforeEach(() => {
    clearKataConfigCache()
    tmpDir = makeTmpDir()
    process.env.CLAUDE_PROJECT_DIR = tmpDir
    // Real-world kata.yaml: NO `default` mode is registered. This is the
    // configuration shipped by `kata setup` / batteries — `default` has
    // never been a registered mode; it was only ever a sentinel string.
    mkdirSync(join(tmpDir, '.kata'), { recursive: true })
    writeFileSync(
      join(tmpDir, '.kata', 'kata.yaml'),
      jsYaml.dump({
        modes: {
          task: { template: 'task.md' },
          freeform: { template: 'freeform.md' },
        },
      }),
    )
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    if (origEnv !== undefined) {
      process.env.CLAUDE_PROJECT_DIR = origEnv
    } else {
      delete process.env.CLAUDE_PROJECT_DIR
    }
    clearKataConfigCache()
  })

  it("does not throw `Mode 'default' not registered` when kata.yaml has no `default` mode", async () => {
    // Regression — exit.ts used to write `currentMode: 'default'`, which the
    // writer's validateCurrentMode rejected when the (correctly absent)
    // `default` mode wasn't registered in kata.yaml. Real users hit this every
    // time they ran `kata exit`. The fix writes `currentMode: undefined`
    // instead, which the writer's null/undefined short-circuit accepts.
    const sessionId = '11111111-1111-1111-1111-111111111111'
    const stateFile = join(tmpDir, '.kata', 'sessions', sessionId, 'state.json')
    const initial: SessionState = {
      sessionId,
      currentMode: 'task',
      sessionType: 'task',
      currentPhase: 'p3',
      completedPhases: [],
      phases: ['p0', 'p1', 'p2', 'p3'],
      modeHistory: [{ mode: 'task', enteredAt: '2026-04-30T00:00:00.000Z' }],
      modeState: {
        task: { status: 'active', enteredAt: '2026-04-30T00:00:00.000Z' },
      },
      beadsCreated: [],
      editedFiles: [],
    }
    mkdirSync(join(tmpDir, '.kata', 'sessions', sessionId), { recursive: true })
    writeFileSync(stateFile, JSON.stringify(initial, null, 2))

    // Should not throw.
    await runExit([`--session=${sessionId}`])

    const written = JSON.parse(readFileSync(stateFile, 'utf-8'))
    // currentMode and sessionType are cleared (omitted from JSON when undefined).
    expect(written.currentMode).toBeUndefined()
    expect(written.sessionType).toBeUndefined()
    // previousMode preserves the mode we exited from.
    expect(written.previousMode).toBe('task')
    // The exited mode is recorded as completed in modeState.
    expect(written.modeState.task.status).toBe('completed')
    expect(written.modeState.task.exitedAt).toBeTruthy()
    expect(written.workflowCompletedAt).toBeTruthy()
  })

  it('round-trips: exit then re-enter (state stays writable)', async () => {
    // After exit, currentMode is undefined. A subsequent `kata enter` call
    // should be able to write a new mode without the writer's mode-validator
    // tripping on stale `default` state.
    const sessionId = '22222222-2222-2222-2222-222222222222'
    const stateFile = join(tmpDir, '.kata', 'sessions', sessionId, 'state.json')
    const initial: SessionState = {
      sessionId,
      currentMode: 'task',
      sessionType: 'task',
      completedPhases: [],
      phases: [],
      modeHistory: [],
      modeState: {},
      beadsCreated: [],
      editedFiles: [],
    }
    mkdirSync(join(tmpDir, '.kata', 'sessions', sessionId), { recursive: true })
    writeFileSync(stateFile, JSON.stringify(initial, null, 2))

    await runExit([`--session=${sessionId}`])

    // Simulate the post-exit writer call that `kata enter` would make next:
    // bumping currentMode back to a registered mode must succeed.
    const { writeState } = await import('../state/writer.js')
    const afterExit = JSON.parse(readFileSync(stateFile, 'utf-8')) as SessionState
    const reEntered: SessionState = { ...afterExit, currentMode: 'freeform' }
    await writeState(stateFile, reEntered)

    const final = JSON.parse(readFileSync(stateFile, 'utf-8'))
    expect(final.currentMode).toBe('freeform')
  })
})
