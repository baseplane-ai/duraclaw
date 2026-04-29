import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import jsYaml from 'js-yaml'
import { clearKataConfigCache } from '../config/kata-config.js'
import type { SessionState } from './schema.js'
import { writeState } from './writer.js'

function makeTmpDir(): string {
  const dir = join(
    os.tmpdir(),
    `kata-writer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeKataYaml(projectRoot: string, modes: Record<string, { template: string }>): void {
  const config = { modes }
  mkdirSync(join(projectRoot, '.kata'), { recursive: true })
  writeFileSync(join(projectRoot, '.kata', 'kata.yaml'), jsYaml.dump(config))
}

describe('writeState — mode validation against kata.yaml', () => {
  let tmpDir: string
  const origEnv = process.env.CLAUDE_PROJECT_DIR

  beforeEach(() => {
    clearKataConfigCache()
    tmpDir = makeTmpDir()
    process.env.CLAUDE_PROJECT_DIR = tmpDir
    // Register the canonical 8 kata modes for test parity with batteries.
    writeKataYaml(tmpDir, {
      research: { template: 'research.md' },
      planning: { template: 'planning.md' },
      implementation: { template: 'implementation.md' },
      task: { template: 'task.md' },
      verify: { template: 'verify.md' },
      debug: { template: 'debug.md' },
      freeform: { template: 'freeform.md' },
      default: { template: 'default.md' },
    })
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

  it('accepts a registered mode (planning)', async () => {
    const stateFile = join(tmpDir, '.kata', 'sessions', 'sess-1', 'state.json')
    const state: SessionState = {
      currentMode: 'planning',
      completedPhases: [],
      phases: [],
      modeHistory: [],
      modeState: {},
      beadsCreated: [],
      editedFiles: [],
    }

    await writeState(stateFile, state)

    const written = JSON.parse(readFileSync(stateFile, 'utf-8'))
    expect(written.currentMode).toBe('planning')
  })

  it('rejects an unregistered mode (foobar)', async () => {
    const stateFile = join(tmpDir, '.kata', 'sessions', 'sess-2', 'state.json')
    const state: SessionState = {
      currentMode: 'foobar',
      completedPhases: [],
      phases: [],
      modeHistory: [],
      modeState: {},
      beadsCreated: [],
      editedFiles: [],
    }

    await expect(writeState(stateFile, state)).rejects.toThrow(
      /Mode 'foobar' not registered in kata\.yaml/,
    )
  })

  it('accepts undefined currentMode (legacy / between-mode state)', async () => {
    const stateFile = join(tmpDir, '.kata', 'sessions', 'sess-3', 'state.json')
    const state: SessionState = {
      currentMode: undefined,
      completedPhases: [],
      phases: [],
      modeHistory: [],
      modeState: {},
      beadsCreated: [],
      editedFiles: [],
    }

    await writeState(stateFile, state)

    const written = JSON.parse(readFileSync(stateFile, 'utf-8'))
    // currentMode is omitted (undefined doesn't serialize to JSON)
    expect(written.currentMode).toBeUndefined()
  })
})
