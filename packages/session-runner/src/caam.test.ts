import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock node:child_process ──────────────────────────────────────────

type SpawnResult = {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

let mockResult: SpawnResult = { status: 0, stdout: '', stderr: '' }
let spawnCalls: Array<{ cmd: string; args: string[] }> = []

vi.mock('node:child_process', () => ({
  spawnSync: (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args })
    return mockResult
  },
}))

// Import AFTER vi.mock so the wrappers pick up the mock.
const { caamLs, caamCooldownList, caamCooldownSet, caamActivate } = await import('./caam.js')

beforeEach(() => {
  spawnCalls = []
  mockResult = { status: 0, stdout: '', stderr: '' }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('caamLs', () => {
  it('parses a realistic JSON array response into CaamProfile[]', () => {
    mockResult = {
      status: 0,
      stdout: JSON.stringify([
        { name: 'work', active: true, system: false },
        { name: 'personal', active: false, system: false },
        { name: 'system-default', active: false, system: true },
      ]),
      stderr: '',
    }
    const profiles = caamLs()
    expect(profiles).toHaveLength(3)
    expect(profiles[0]).toMatchObject({ name: 'work', active: true, system: false })
    expect(spawnCalls[0]).toMatchObject({ args: ['ls', 'claude', '--json'] })
  })

  it('returns [] when spawnSync exits non-zero', () => {
    mockResult = { status: 1, stdout: '', stderr: 'boom' }
    expect(caamLs()).toEqual([])
  })

  it('returns [] when JSON parse fails', () => {
    mockResult = { status: 0, stdout: 'not json {{{', stderr: '' }
    expect(caamLs()).toEqual([])
  })
})

describe('caamCooldownList', () => {
  it('returns a Set<string> of profile names from array shape', () => {
    mockResult = {
      status: 0,
      stdout: JSON.stringify([{ name: 'work' }, { name: 'personal' }]),
      stderr: '',
    }
    const set = caamCooldownList()
    expect(set).toBeInstanceOf(Set)
    expect(set.has('work')).toBe(true)
    expect(set.has('personal')).toBe(true)
    expect(set.size).toBe(2)
    expect(spawnCalls[0]).toMatchObject({ args: ['cooldown', 'list', '--json'] })
  })

  it('returns empty set on error', () => {
    mockResult = { status: 2, stdout: '', stderr: 'nope' }
    const set = caamCooldownList()
    expect(set.size).toBe(0)
  })
})

describe('caamCooldownSet', () => {
  it('invokes `caam cooldown set claude/<name> --minutes N` with N from delta', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-25T00:00:00Z'))
    const nowSec = Math.floor(Date.now() / 1000)
    const untilSec = nowSec + 30 * 60 // 30 minutes out

    mockResult = { status: 0, stdout: '', stderr: '' }
    const ok = caamCooldownSet('work', untilSec)
    expect(ok).toBe(true)
    expect(spawnCalls[0].args).toEqual(['cooldown', 'set', 'claude/work', '--minutes', '30'])
  })

  it('clamps to --minutes 1 when delta is negative or zero', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-25T00:00:00Z'))
    const nowSec = Math.floor(Date.now() / 1000)

    mockResult = { status: 0, stdout: '', stderr: '' }
    caamCooldownSet('past', nowSec - 1000)
    expect(spawnCalls[0].args).toEqual(['cooldown', 'set', 'claude/past', '--minutes', '1'])
  })

  it('returns false on non-zero exit', () => {
    mockResult = { status: 1, stdout: '', stderr: 'fail' }
    expect(caamCooldownSet('work', Math.floor(Date.now() / 1000) + 600)).toBe(false)
  })
})

describe('caamActivate', () => {
  it('invokes `caam activate claude <name>` and returns true on exit 0', () => {
    mockResult = { status: 0, stdout: '', stderr: '' }
    const ok = caamActivate('personal')
    expect(ok).toBe(true)
    expect(spawnCalls[0].args).toEqual(['activate', 'claude', 'personal'])
  })

  it('returns false on non-zero exit', () => {
    mockResult = { status: 7, stdout: '', stderr: 'no such profile' }
    expect(caamActivate('ghost')).toBe(false)
  })
})
