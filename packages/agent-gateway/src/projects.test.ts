import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deriveProjectId } from '@duraclaw/shared-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// We need to re-import the module for each test to pick up different env values.
// vi.stubEnv + vi.resetModules + dynamic import achieves this.

let discoverProjects: (activeSessions: Record<string, string>) => Promise<any[]>
let resolveProject: (name: string) => Promise<string | null>
let registerProjectWithOrchestrator: (
  projectPath: string,
  originUrl: string | null,
) => Promise<string | null>

async function loadModule() {
  const mod = await import('./projects.js')
  discoverProjects = mod.discoverProjects
  resolveProject = mod.resolveProject
  registerProjectWithOrchestrator = mod.registerProjectWithOrchestrator
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('resolveProject with HIDDEN_PROJECTS', () => {
  it('resolves a project when HIDDEN_PROJECTS is empty', async () => {
    vi.stubEnv('HIDDEN_PROJECTS', '')
    vi.stubEnv('PROJECT_PATTERNS', '')
    vi.stubEnv('WORKTREE_PATTERNS', '')
    await loadModule()

    const result = await resolveProject('duraclaw')
    expect(result).toBe('/data/projects/duraclaw')
  })

  it('returns null for a hidden project', async () => {
    vi.stubEnv('HIDDEN_PROJECTS', 'duraclaw')
    vi.stubEnv('PROJECT_PATTERNS', '')
    vi.stubEnv('WORKTREE_PATTERNS', '')
    await loadModule()

    const result = await resolveProject('duraclaw')
    expect(result).toBeNull()
  })

  it('returns null when project is in comma-separated hidden list', async () => {
    vi.stubEnv('HIDDEN_PROJECTS', 'other-project, duraclaw, another')
    vi.stubEnv('PROJECT_PATTERNS', '')
    vi.stubEnv('WORKTREE_PATTERNS', '')
    await loadModule()

    const result = await resolveProject('duraclaw')
    expect(result).toBeNull()
  })

  it('allows non-hidden projects when HIDDEN_PROJECTS is set', async () => {
    vi.stubEnv('HIDDEN_PROJECTS', 'some-nonexistent-thing')
    vi.stubEnv('PROJECT_PATTERNS', '')
    vi.stubEnv('WORKTREE_PATTERNS', '')
    await loadModule()

    const result = await resolveProject('duraclaw')
    expect(result).toBe('/data/projects/duraclaw')
  })

  it('trims whitespace in HIDDEN_PROJECTS values', async () => {
    vi.stubEnv('HIDDEN_PROJECTS', '  duraclaw  ,  other  ')
    vi.stubEnv('PROJECT_PATTERNS', '')
    vi.stubEnv('WORKTREE_PATTERNS', '')
    await loadModule()

    const result = await resolveProject('duraclaw')
    expect(result).toBeNull()
  })

  it('still rejects path traversal even when not hidden', async () => {
    vi.stubEnv('HIDDEN_PROJECTS', '')
    vi.stubEnv('PROJECT_PATTERNS', '')
    vi.stubEnv('WORKTREE_PATTERNS', '')
    await loadModule()

    expect(await resolveProject('../etc')).toBeNull()
    expect(await resolveProject('foo/bar')).toBeNull()
  })
})

describe('discoverProjects with HIDDEN_PROJECTS', () => {
  // discoverProjects shells out (git + gh pr list) for every directory in /data/projects.
  // On dev hosts with many projects the default 5s timeout is too tight.
  const TEST_TIMEOUT = 60_000

  it(
    'excludes hidden projects from discovery results',
    async () => {
      vi.stubEnv('HIDDEN_PROJECTS', 'duraclaw')
      vi.stubEnv('PROJECT_PATTERNS', 'duraclaw')
      vi.stubEnv('WORKTREE_PATTERNS', '')
      await loadModule()

      const projects = await discoverProjects({})
      const names = projects.map((p: any) => p.name)
      expect(names).not.toContain('duraclaw')
    },
    TEST_TIMEOUT,
  )

  it(
    'includes non-hidden projects in discovery results',
    async () => {
      vi.stubEnv('HIDDEN_PROJECTS', 'nonexistent-project-xyz')
      vi.stubEnv('PROJECT_PATTERNS', 'duraclaw')
      vi.stubEnv('WORKTREE_PATTERNS', '')
      await loadModule()

      const projects = await discoverProjects({})
      const names = projects.map((p: any) => p.name)
      expect(names).toContain('duraclaw')
    },
    TEST_TIMEOUT,
  )

  it(
    'can hide multiple projects at once',
    async () => {
      vi.stubEnv('HIDDEN_PROJECTS', 'duraclaw,nonexistent-abc')
      vi.stubEnv('PROJECT_PATTERNS', 'duraclaw')
      vi.stubEnv('WORKTREE_PATTERNS', '')
      await loadModule()

      const projects = await discoverProjects({})
      const names = projects.map((p: any) => p.name)
      expect(names).not.toContain('duraclaw')
      expect(names).not.toContain('nonexistent-abc')
    },
    TEST_TIMEOUT,
  )
})

describe('nested project discovery (PROJECT_MAX_DEPTH)', () => {
  // Same rationale as the HIDDEN_PROJECTS suite above: discoverProjects
  // shells out to git/gh for every repo under /data/projects, which can
  // trip the 5s default on busy hosts. Apply the suite-wide timeout via
  // vitest's third-arg mechanism on each `it`.
  const TEST_TIMEOUT = 60_000

  it(
    'discovers git repos nested one level below container directories',
    async () => {
      vi.stubEnv('HIDDEN_PROJECTS', '')
      vi.stubEnv('PROJECT_PATTERNS', '')
      vi.stubEnv('WORKTREE_PATTERNS', '')
      vi.stubEnv('PROJECT_MAX_DEPTH', '2')
      await loadModule()

      const projects = await discoverProjects({})
      const names = projects.map((p: any) => p.name)
      // /data/projects/packages is a non-git container dir holding `nanobanana`
      expect(names).toContain('packages/nanobanana')
    },
    TEST_TIMEOUT,
  )

  it(
    'does not surface non-git container directories as projects',
    async () => {
      vi.stubEnv('HIDDEN_PROJECTS', '')
      vi.stubEnv('PROJECT_PATTERNS', '')
      vi.stubEnv('WORKTREE_PATTERNS', '')
      vi.stubEnv('PROJECT_MAX_DEPTH', '2')
      await loadModule()

      const projects = await discoverProjects({})
      const names = projects.map((p: any) => p.name)
      expect(names).not.toContain('packages')
    },
    TEST_TIMEOUT,
  )

  it(
    'skips nested discovery when PROJECT_MAX_DEPTH=1',
    async () => {
      vi.stubEnv('HIDDEN_PROJECTS', '')
      vi.stubEnv('PROJECT_PATTERNS', '')
      vi.stubEnv('WORKTREE_PATTERNS', '')
      vi.stubEnv('PROJECT_MAX_DEPTH', '1')
      await loadModule()

      const projects = await discoverProjects({})
      const names = projects.map((p: any) => p.name)
      expect(names).not.toContain('packages/nanobanana')
      // Top-level repos still present
      expect(names).toContain('duraclaw')
    },
    TEST_TIMEOUT,
  )

  it('resolves a nested project name to its full path', async () => {
    vi.stubEnv('HIDDEN_PROJECTS', '')
    vi.stubEnv('PROJECT_PATTERNS', '')
    vi.stubEnv('WORKTREE_PATTERNS', '')
    vi.stubEnv('PROJECT_MAX_DEPTH', '2')
    await loadModule()

    const result = await resolveProject('packages/nanobanana')
    expect(result).toBe('/data/projects/packages/nanobanana')
  })

  it('rejects absolute paths and traversal attempts', async () => {
    vi.stubEnv('HIDDEN_PROJECTS', '')
    vi.stubEnv('PROJECT_PATTERNS', '')
    vi.stubEnv('WORKTREE_PATTERNS', '')
    vi.stubEnv('PROJECT_MAX_DEPTH', '2')
    await loadModule()

    expect(await resolveProject('/etc/passwd')).toBeNull()
    expect(await resolveProject('..')).toBeNull()
    expect(await resolveProject('packages/../..')).toBeNull()
    expect(await resolveProject('packages/../etc')).toBeNull()
  })

  it('rejects nested names when they exceed PROJECT_MAX_DEPTH', async () => {
    vi.stubEnv('HIDDEN_PROJECTS', '')
    vi.stubEnv('PROJECT_PATTERNS', '')
    vi.stubEnv('WORKTREE_PATTERNS', '')
    vi.stubEnv('PROJECT_MAX_DEPTH', '1')
    await loadModule()

    expect(await resolveProject('packages/nanobanana')).toBeNull()
  })

  it(
    'hides nested projects by leaf segment name',
    async () => {
      vi.stubEnv('HIDDEN_PROJECTS', 'nanobanana')
      vi.stubEnv('PROJECT_PATTERNS', '')
      vi.stubEnv('WORKTREE_PATTERNS', '')
      vi.stubEnv('PROJECT_MAX_DEPTH', '2')
      await loadModule()

      const projects = await discoverProjects({})
      const names = projects.map((p: any) => p.name)
      expect(names).not.toContain('packages/nanobanana')
      expect(await resolveProject('packages/nanobanana')).toBeNull()
    },
    TEST_TIMEOUT,
  )

  it(
    'hides nested projects by full relative name',
    async () => {
      vi.stubEnv('HIDDEN_PROJECTS', 'packages/nanobanana')
      vi.stubEnv('PROJECT_PATTERNS', '')
      vi.stubEnv('WORKTREE_PATTERNS', '')
      vi.stubEnv('PROJECT_MAX_DEPTH', '2')
      await loadModule()

      const projects = await discoverProjects({})
      const names = projects.map((p: any) => p.name)
      expect(names).not.toContain('packages/nanobanana')
    },
    TEST_TIMEOUT,
  )
})

describe('registerProjectWithOrchestrator (GH#27 P1.1-C)', () => {
  let tmpRoot: string
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duraclaw-projects-test-'))
    vi.stubEnv('WORKER_PUBLIC_URL', 'https://orchestrator.example.com')
    vi.stubEnv('DOCS_RUNNER_SECRET', 'test-secret-xyz')
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    await loadModule()
  })

  afterEach(async () => {
    fetchSpy.mockRestore()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('uses deriveProjectId(originUrl) when origin URL is provided', async () => {
    const projectPath = path.join(tmpRoot, 'has-origin')
    await fs.mkdir(projectPath, { recursive: true })

    const originUrl = 'git@github.com:baseplane-ai/duraclaw.git'
    const expectedId = await deriveProjectId(originUrl)

    const id = await registerProjectWithOrchestrator(projectPath, originUrl)
    expect(id).toBe(expectedId)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe(`https://orchestrator.example.com/api/projects/${expectedId}`)
    expect(init.method).toBe('PATCH')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-secret-xyz')
    expect(headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ projectName: 'has-origin', originUrl })
  })

  it('mints + persists a 16-char UUID-derived ID when no origin and no existing id file', async () => {
    const projectPath = path.join(tmpRoot, 'no-origin')
    await fs.mkdir(projectPath, { recursive: true })

    const id = await registerProjectWithOrchestrator(projectPath, null)
    expect(id).toMatch(/^[0-9a-f]{16}$/)

    // File should exist with the same id.
    const persisted = (
      await fs.readFile(path.join(projectPath, '.duraclaw', 'project-id'), 'utf8')
    ).trim()
    expect(persisted).toBe(id)

    // Fetch was issued with originUrl=null + minted id.
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe(`https://orchestrator.example.com/api/projects/${id}`)
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ projectName: 'no-origin', originUrl: null })
  })

  it('reuses an existing .duraclaw/project-id when present and no origin', async () => {
    const projectPath = path.join(tmpRoot, 'preexisting-id')
    await fs.mkdir(path.join(projectPath, '.duraclaw'), { recursive: true })
    const existingId = 'deadbeefcafebabe'
    await fs.writeFile(path.join(projectPath, '.duraclaw', 'project-id'), existingId, 'utf8')

    const id = await registerProjectWithOrchestrator(projectPath, null)
    expect(id).toBe(existingId)

    // No re-mint: file unchanged.
    const persisted = (
      await fs.readFile(path.join(projectPath, '.duraclaw', 'project-id'), 'utf8')
    ).trim()
    expect(persisted).toBe(existingId)
  })

  it('does NOT throw when fetch rejects; logs warning and returns the resolved id', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const projectPath = path.join(tmpRoot, 'fetch-fail')
    await fs.mkdir(projectPath, { recursive: true })
    const originUrl = 'https://example.com/repo.git'
    const expectedId = await deriveProjectId(originUrl)

    let result: string | null = null
    await expect(
      (async () => {
        result = await registerProjectWithOrchestrator(projectPath, originUrl)
      })(),
    ).resolves.not.toThrow()

    expect(result).toBe(expectedId)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('is idempotent — second call issues another PATCH (orchestrator UPSERTs)', async () => {
    const projectPath = path.join(tmpRoot, 'idempotent')
    await fs.mkdir(projectPath, { recursive: true })
    const originUrl = 'git@github.com:baseplane-ai/duraclaw.git'
    const expectedId = await deriveProjectId(originUrl)

    const id1 = await registerProjectWithOrchestrator(projectPath, originUrl)
    const id2 = await registerProjectWithOrchestrator(projectPath, originUrl)

    expect(id1).toBe(expectedId)
    expect(id2).toBe(expectedId)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const url1 = fetchSpy.mock.calls[0][0]
    const url2 = fetchSpy.mock.calls[1][0]
    expect(url1).toBe(url2)
    expect(url1).toBe(`https://orchestrator.example.com/api/projects/${expectedId}`)
  })
})
