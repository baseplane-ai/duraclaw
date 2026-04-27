import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeTask } from '../drivers/types.js'
import {
  clearCanonicalTasks,
  getCanonicalTasksDir,
  readCanonicalTask,
  readCanonicalTasks,
  writeCanonicalTask,
  writeCanonicalTasks,
} from './canonical-store.js'

const SESSION_ID = 'test-sess-1'

function setupTmpProject(): string {
  const tmpDir = join(
    tmpdir(),
    `kata-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(join(tmpDir, '.kata', 'sessions', SESSION_ID, 'native-tasks'), { recursive: true })
  mkdirSync(join(tmpDir, '.git'), { recursive: true })
  writeFileSync(join(tmpDir, '.kata', 'kata.yaml'), 'project:\n  name: test\n')
  return tmpDir
}

function makeTask(overrides: Partial<NativeTask> & { id: string }): NativeTask {
  return {
    subject: `Task ${overrides.id}`,
    description: `Description for task ${overrides.id}`,
    activeForm: `Working on task ${overrides.id}`,
    status: 'pending',
    blocks: [],
    blockedBy: [],
    metadata: {},
    ...overrides,
  }
}

describe('canonical-store', () => {
  let tmpDir: string
  let origCwd: string

  beforeEach(() => {
    tmpDir = setupTmpProject()
    origCwd = process.cwd()
    process.chdir(tmpDir)
  })

  afterEach(() => {
    process.chdir(origCwd)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getCanonicalTasksDir returns correct path', () => {
    const dir = getCanonicalTasksDir(SESSION_ID)
    expect(dir).toBe(join(tmpDir, '.kata', 'sessions', SESSION_ID, 'native-tasks'))
  })

  it('writeCanonicalTask + readCanonicalTask round-trip', () => {
    const task = makeTask({ id: '1', blocks: ['2'], status: 'in_progress' })
    writeCanonicalTask(SESSION_ID, task)
    const read = readCanonicalTask(SESSION_ID, '1')
    expect(read).toEqual(task)
  })

  it('readCanonicalTask returns null for missing ID', () => {
    const result = readCanonicalTask(SESSION_ID, 'nonexistent')
    expect(result).toBeNull()
  })

  it('readCanonicalTasks returns sorted by numeric ID', () => {
    const t3 = makeTask({ id: '3' })
    const t1 = makeTask({ id: '1' })
    const t2 = makeTask({ id: '2' })
    writeCanonicalTask(SESSION_ID, t3)
    writeCanonicalTask(SESSION_ID, t1)
    writeCanonicalTask(SESSION_ID, t2)

    const tasks = readCanonicalTasks(SESSION_ID)
    expect(tasks).toHaveLength(3)
    expect(tasks.map((t) => t.id)).toEqual(['1', '2', '3'])
  })

  it('readCanonicalTasks returns empty array when no tasks exist', () => {
    // Clear the pre-created directory so it does not exist
    clearCanonicalTasks(SESSION_ID)
    const tasks = readCanonicalTasks(SESSION_ID)
    expect(tasks).toEqual([])
  })

  it('clearCanonicalTasks removes all task files', () => {
    writeCanonicalTask(SESSION_ID, makeTask({ id: '1' }))
    writeCanonicalTask(SESSION_ID, makeTask({ id: '2' }))
    writeCanonicalTask(SESSION_ID, makeTask({ id: '3' }))

    clearCanonicalTasks(SESSION_ID)

    const dir = getCanonicalTasksDir(SESSION_ID)
    expect(existsSync(dir)).toBe(false)
    expect(readCanonicalTasks(SESSION_ID)).toEqual([])
  })

  it('writeCanonicalTasks bulk writes all tasks', () => {
    const tasks = [makeTask({ id: '1' }), makeTask({ id: '2' }), makeTask({ id: '3' })]
    writeCanonicalTasks(SESSION_ID, tasks)

    const read = readCanonicalTasks(SESSION_ID)
    expect(read).toHaveLength(3)
    expect(read.map((t) => t.id)).toEqual(['1', '2', '3'])
    expect(read[0]).toEqual(tasks[0])
  })

  it('writeCanonicalTasks clears existing tasks before writing', () => {
    const first = [
      makeTask({ id: '10' }),
      makeTask({ id: '11' }),
      makeTask({ id: '12' }),
      makeTask({ id: '13' }),
      makeTask({ id: '14' }),
    ]
    writeCanonicalTasks(SESSION_ID, first)
    expect(readCanonicalTasks(SESSION_ID)).toHaveLength(5)

    const second = [makeTask({ id: '20' }), makeTask({ id: '21' }), makeTask({ id: '22' })]
    writeCanonicalTasks(SESSION_ID, second)

    const read = readCanonicalTasks(SESSION_ID)
    expect(read).toHaveLength(3)
    expect(read.map((t) => t.id)).toEqual(['20', '21', '22'])
  })

  it('writeCanonicalTask creates directory if it does not exist', () => {
    clearCanonicalTasks(SESSION_ID)
    const dir = getCanonicalTasksDir(SESSION_ID)
    expect(existsSync(dir)).toBe(false)

    writeCanonicalTask(SESSION_ID, makeTask({ id: '1' }))
    expect(existsSync(dir)).toBe(true)
    expect(readCanonicalTask(SESSION_ID, '1')).not.toBeNull()
  })

  it('readCanonicalTask ignores corrupt JSON files gracefully', () => {
    const dir = getCanonicalTasksDir(SESSION_ID)
    writeFileSync(join(dir, '99.json'), 'not valid json{{{', 'utf-8')

    const result = readCanonicalTask(SESSION_ID, '99')
    expect(result).toBeNull()
  })

  it('readCanonicalTasks skips corrupt files and returns valid ones', () => {
    writeCanonicalTask(SESSION_ID, makeTask({ id: '1' }))
    const dir = getCanonicalTasksDir(SESSION_ID)
    writeFileSync(join(dir, '2.json'), '{{bad json}}', 'utf-8')
    writeCanonicalTask(SESSION_ID, makeTask({ id: '3' }))

    const tasks = readCanonicalTasks(SESSION_ID)
    expect(tasks).toHaveLength(2)
    expect(tasks.map((t) => t.id)).toEqual(['1', '3'])
  })
})
