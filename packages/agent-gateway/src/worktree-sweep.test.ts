/**
 * GH#115 P1.3: classifyClone unit coverage.
 *
 * Each test creates a tmpdir holding a fake clone with a real `.git`
 * subdir (mock: just an empty dir is enough — all the git lookups
 * happen via execFile against `git -C <tmpdir>` so they need a real
 * repo). We init a tiny throwaway repo per case, then assert classify
 * output against the spec's branch heuristic + reservation override
 * (B-DISCOVERY-2 / B-DISCOVERY-3 / B-DISCOVERY-2b).
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyClone } from './worktree-sweep.js'

const execFileAsync = promisify(execFile)

async function makeRepo(absPath: string, branch: string): Promise<void> {
  await fs.mkdir(absPath, { recursive: true })
  await execFileAsync('git', ['init', '-q', '-b', branch, absPath])
  // Need at least one commit so refs/HEAD resolves to a real branch.
  await execFileAsync('git', ['-C', absPath, 'config', 'user.email', 'test@example.com'])
  await execFileAsync('git', ['-C', absPath, 'config', 'user.name', 'Test'])
  await fs.writeFile(path.join(absPath, 'README'), 'hi\n')
  await execFileAsync('git', ['-C', absPath, 'add', '.'])
  await execFileAsync('git', ['-C', absPath, 'commit', '-q', '-m', 'init'])
}

describe('classifyClone (GH#115 P1.3)', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duraclaw-worktree-sweep-test-'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('returns null + warns when path is missing or has no .git', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Missing path
    const missing = path.join(tmpRoot, 'does-not-exist')
    expect(await classifyClone(missing)).toBeNull()

    // Path exists but no .git
    const nogit = path.join(tmpRoot, 'nogit')
    await fs.mkdir(nogit, { recursive: true })
    expect(await classifyClone(nogit)).toBeNull()

    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('classifies a clone on the default branch with no reservation as free', async () => {
    vi.stubEnv('CC_DEFAULT_BRANCH', 'main')
    const repo = path.join(tmpRoot, 'on-main')
    await makeRepo(repo, 'main')

    const result = await classifyClone(repo)
    expect(result).not.toBeNull()
    expect(result?.path).toBe(repo)
    expect(result?.branch).toBe('main')
    expect(result?.reservedBy).toBeNull()
    expect(result?.reservationOwnerUserId).toBeUndefined()
  })

  it('classifies a clone on a non-default branch with no reservation as manual', async () => {
    vi.stubEnv('CC_DEFAULT_BRANCH', 'main')
    const repo = path.join(tmpRoot, 'on-feature')
    await makeRepo(repo, 'feat/cool')

    const result = await classifyClone(repo)
    expect(result?.branch).toBe('feat/cool')
    expect(result?.reservedBy).toEqual({ kind: 'manual', id: 'feat/cool' })
  })

  it('honors .duraclaw/reservation.json override (file always wins)', async () => {
    vi.stubEnv('CC_DEFAULT_BRANCH', 'main')
    const repo = path.join(tmpRoot, 'reserved')
    await makeRepo(repo, 'main') // would otherwise be free
    await fs.mkdir(path.join(repo, '.duraclaw'), { recursive: true })
    await fs.writeFile(
      path.join(repo, '.duraclaw', 'reservation.json'),
      JSON.stringify({ kind: 'arc', id: 115, userId: 'user-abc' }),
    )

    const result = await classifyClone(repo)
    expect(result?.reservedBy).toEqual({ kind: 'arc', id: 115 })
    expect(result?.reservationOwnerUserId).toBe('user-abc')
  })

  it('treats malformed reservation.json as absent and warns', async () => {
    vi.stubEnv('CC_DEFAULT_BRANCH', 'main')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const repo = path.join(tmpRoot, 'bad-reservation')
    await makeRepo(repo, 'main')
    await fs.mkdir(path.join(repo, '.duraclaw'), { recursive: true })
    await fs.writeFile(path.join(repo, '.duraclaw', 'reservation.json'), 'not-json{')

    const result = await classifyClone(repo)
    // Falls through to branch heuristic — main → free.
    expect(result?.reservedBy).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('treats reservation.json with bad schema as absent', async () => {
    vi.stubEnv('CC_DEFAULT_BRANCH', 'main')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const repo = path.join(tmpRoot, 'schema-bad')
    await makeRepo(repo, 'feat/x')
    await fs.mkdir(path.join(repo, '.duraclaw'), { recursive: true })
    await fs.writeFile(
      path.join(repo, '.duraclaw', 'reservation.json'),
      JSON.stringify({ kind: 'invalid-kind', id: 1 }),
    )

    const result = await classifyClone(repo)
    // Falls through to branch heuristic — feat/x → manual.
    expect(result?.reservedBy).toEqual({ kind: 'manual', id: 'feat/x' })
    warnSpy.mockRestore()
  })
})
