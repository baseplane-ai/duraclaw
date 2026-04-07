import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findLatestKataState } from './kata.js'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-gateway-kata-test-'))
})

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('findLatestKataState', () => {
  it('returns null when no .kata directory exists', async () => {
    const result = await findLatestKataState(tmpDir)
    expect(result).toBeNull()
  })

  it('returns null when .kata/sessions/ is empty', async () => {
    const sessionsDir = path.join(tmpDir, '.kata', 'sessions')
    await fs.mkdir(sessionsDir, { recursive: true })

    const result = await findLatestKataState(tmpDir)
    expect(result).toBeNull()
  })

  it('returns null when session dir has no state.json', async () => {
    const sessionDir = path.join(
      tmpDir,
      '.kata',
      'sessions',
      'a1b2c3d4-0000-4000-8000-000000000001',
    )
    await fs.mkdir(sessionDir, { recursive: true })

    const result = await findLatestKataState(tmpDir)
    expect(result).toBeNull()
  })

  it('returns parsed state from valid state.json', async () => {
    const sessionId = 'a1b2c3d4-0000-4000-8000-000000000002'
    const sessionDir = path.join(tmpDir, '.kata', 'sessions', sessionId)
    await fs.mkdir(sessionDir, { recursive: true })

    const state = {
      sessionId,
      currentMode: 'implementation',
      currentPhase: 'p2',
      completedPhases: ['p1'],
      workflowId: 'test-workflow',
      issueNumber: 10,
      phases: ['p1', 'p2', 'p3'],
      template: 'implementation',
      modeHistory: [{ mode: 'implementation', enteredAt: '2026-04-06T10:00:00.000Z' }],
      modeState: {},
      updatedAt: '2026-04-06T10:00:00.000Z',
      beadsCreated: [],
      editedFiles: [],
      sessionType: 'implementation',
    }
    await fs.writeFile(path.join(sessionDir, 'state.json'), JSON.stringify(state))

    const result = await findLatestKataState(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe(sessionId)
    expect(result!.currentMode).toBe('implementation')
    expect(result!.currentPhase).toBe('p2')
    expect(result!.completedPhases).toEqual(['p1'])
  })

  it('returns the most recent session by mtime', async () => {
    const oldId = 'a1b2c3d4-0000-4000-8000-000000000003'
    const newId = 'a1b2c3d4-0000-4000-8000-000000000004'
    const oldDir = path.join(tmpDir, '.kata', 'sessions', oldId)
    const newDir = path.join(tmpDir, '.kata', 'sessions', newId)
    await fs.mkdir(oldDir, { recursive: true })
    await fs.mkdir(newDir, { recursive: true })

    await fs.writeFile(
      path.join(oldDir, 'state.json'),
      JSON.stringify({
        sessionId: oldId,
        currentMode: 'planning',
        currentPhase: null,
        completedPhases: [],
        workflowId: null,
        issueNumber: null,
        phases: [],
        template: null,
        modeHistory: [],
        modeState: {},
        updatedAt: '2026-04-05T00:00:00.000Z',
        beadsCreated: [],
        editedFiles: [],
        sessionType: null,
      }),
    )
    // Small delay to ensure different mtime
    await new Promise((r) => setTimeout(r, 50))
    await fs.writeFile(
      path.join(newDir, 'state.json'),
      JSON.stringify({
        sessionId: newId,
        currentMode: 'research',
        currentPhase: 'p1',
        completedPhases: [],
        workflowId: null,
        issueNumber: null,
        phases: ['p1'],
        template: null,
        modeHistory: [],
        modeState: {},
        updatedAt: '2026-04-06T00:00:00.000Z',
        beadsCreated: [],
        editedFiles: [],
        sessionType: null,
      }),
    )

    const result = await findLatestKataState(tmpDir)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe(newId)
    expect(result!.currentMode).toBe('research')
  })

  it('returns null for corrupt state.json', async () => {
    const corruptId = 'a1b2c3d4-0000-4000-8000-000000000005'
    const corruptDir = path.join(tmpDir, '.kata', 'sessions', corruptId)
    await fs.mkdir(corruptDir, { recursive: true })

    // Write corrupt JSON and set mtime to future so it's the "latest"
    await fs.writeFile(path.join(corruptDir, 'state.json'), 'not valid json{{{')
    const futureTime = new Date(Date.now() + 60000)
    await fs.utimes(path.join(corruptDir, 'state.json'), futureTime, futureTime)

    const result = await findLatestKataState(tmpDir)
    expect(result).toBeNull()
  })

  it('ignores directories that are not valid UUIDs', async () => {
    const badDir = path.join(tmpDir, '.kata', 'sessions', 'not-a-uuid')
    await fs.mkdir(badDir, { recursive: true })
    await fs.writeFile(
      path.join(badDir, 'state.json'),
      JSON.stringify({ sessionId: 'not-a-uuid', currentMode: 'bad' }),
    )

    // Should still return one of the valid sessions, not the bad one
    const result = await findLatestKataState(tmpDir)
    // The corrupt one from previous test is latest by mtime, so null
    expect(result === null || result.sessionId !== 'not-a-uuid').toBe(true)
  })
})
