import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock node:child_process before importing the module under test so the
// module's `import { spawnSync } from 'node:child_process'` binds to the spy.
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

import { spawnSync } from 'node:child_process'
import { handleActivateProfile, handleListProfiles } from './admin-caam.js'

const spawnSyncMock = spawnSync as unknown as ReturnType<typeof vi.fn>

interface MockResult {
  status: number | null
  signal?: NodeJS.Signals | null
  stdout?: string
  stderr?: string
  error?: NodeJS.ErrnoException
}

function mock(result: MockResult) {
  return {
    pid: 0,
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: [null, result.stdout ?? '', result.stderr ?? ''],
    error: result.error,
  }
}

/** Route a spawnSync call to a per-subcommand result based on `args`. */
function routeMock(routes: {
  ls?: MockResult
  limits?: MockResult
  cooldown?: MockResult
  activate?: MockResult
}) {
  spawnSyncMock.mockImplementation((_bin: string, args: string[]) => {
    if (args[0] === 'ls') return mock(routes.ls ?? { status: 0, stdout: '[]' })
    if (args[0] === 'limits') return mock(routes.limits ?? { status: 0, stdout: '[]' })
    if (args[0] === 'cooldown' && args[1] === 'list') {
      return mock(routes.cooldown ?? { status: 0, stdout: '[]' })
    }
    if (args[0] === 'activate') return mock(routes.activate ?? { status: 0, stdout: '' })
    return mock({ status: 1, stderr: `unexpected args: ${args.join(' ')}` })
  })
}

beforeEach(() => {
  spawnSyncMock.mockReset()
})

describe('handleListProfiles', () => {
  it('merges ls + limits + cooldown into a profile list (200)', async () => {
    routeMock({
      ls: {
        status: 0,
        stdout: JSON.stringify([
          {
            name: 'work',
            active: true,
            system: false,
            plan: 'pro',
            health: { expires_at: 1745000000 },
          },
          { name: 'spare', active: false, system: false, plan: 'pro' },
          { name: '__system', active: false, system: true },
        ]),
      },
      limits: {
        status: 0,
        stdout: JSON.stringify([
          { name: 'work', util_7d_pct: 87.4, resets_at: 1745100000 },
          { name: 'spare', util_7d_pct: 12.0 },
        ]),
      },
      cooldown: {
        status: 0,
        stdout: JSON.stringify([{ name: 'spare', until: 1745200000 }]),
      },
    })

    const res = await handleListProfiles()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { profiles: any[] }
    expect(body.profiles).toHaveLength(3)

    const work = body.profiles.find((p) => p.name === 'work')!
    expect(work.active).toBe(true)
    expect(work.system).toBe(false)
    expect(work.plan).toBe('pro')
    expect(work.util_7d_pct).toBe(87.4)
    // resets_at preferred from limits, converted to ISO
    expect(work.resets_at).toBe(new Date(1745100000 * 1000).toISOString())
    expect(work.cooldown_until).toBeNull()

    const spare = body.profiles.find((p) => p.name === 'spare')!
    expect(spare.active).toBe(false)
    expect(spare.util_7d_pct).toBe(12.0)
    expect(spare.cooldown_until).toBe(new Date(1745200000 * 1000).toISOString())

    const sys = body.profiles.find((p) => p.name === '__system')!
    expect(sys.system).toBe(true)
    expect(sys.util_7d_pct).toBeNull()
  })

  it('returns 503 caam_unavailable when caam binary is missing', async () => {
    const enoent = Object.assign(new Error('not found'), {
      code: 'ENOENT',
    }) as NodeJS.ErrnoException
    spawnSyncMock.mockImplementation(() => mock({ status: null, stderr: '', error: enoent }))

    const res = await handleListProfiles()
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('caam_unavailable')
  })

  it('returns 500 caam_error when ls fails non-zero', async () => {
    routeMock({
      ls: { status: 1, stderr: 'boom' },
    })
    const res = await handleListProfiles()
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('caam_error')
    expect(body.message).toContain('boom')
  })
})

describe('handleActivateProfile', () => {
  it('returns 400 invalid_body when profile missing', async () => {
    const res1 = await handleActivateProfile(null)
    expect(res1.status).toBe(400)
    const res2 = await handleActivateProfile({})
    expect(res2.status).toBe(400)
    const res3 = await handleActivateProfile({ profile: '' })
    expect(res3.status).toBe(400)
    const res4 = await handleActivateProfile({ profile: 42 })
    expect(res4.status).toBe(400)
    expect(((await res1.json()) as { error: string }).error).toBe('invalid_body')
  })

  it('runs caam activate then re-fetches the merged list (200)', async () => {
    routeMock({
      activate: { status: 0, stdout: 'switched' },
      ls: {
        status: 0,
        stdout: JSON.stringify([
          { name: 'work', active: false, system: false },
          { name: 'spare', active: true, system: false },
        ]),
      },
      limits: { status: 0, stdout: '[]' },
      cooldown: { status: 0, stdout: '[]' },
    })

    const res = await handleActivateProfile({ profile: 'spare' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { profiles: any[] }
    expect(body.profiles).toHaveLength(2)
    expect(body.profiles.find((p) => p.name === 'spare')!.active).toBe(true)
    expect(body.profiles.find((p) => p.name === 'work')!.active).toBe(false)

    // First call must be the activate
    const activateCall = spawnSyncMock.mock.calls.find((c) => c[1][0] === 'activate')
    expect(activateCall).toBeDefined()
    expect(activateCall![1]).toEqual(['activate', 'claude', 'spare'])
  })

  it('returns 502 activate_failed when caam exits non-zero', async () => {
    routeMock({
      activate: { status: 1, stderr: 'profile not found' },
    })

    const res = await handleActivateProfile({ profile: 'ghost' })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; stderr: string }
    expect(body.error).toBe('activate_failed')
    expect(body.stderr).toContain('profile not found')
  })
})
