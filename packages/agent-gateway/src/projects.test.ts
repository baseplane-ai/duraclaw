import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// We need to re-import the module for each test to pick up different env values.
// vi.stubEnv + vi.resetModules + dynamic import achieves this.

let discoverProjects: (activeSessions: Record<string, string>) => Promise<any[]>
let resolveProject: (name: string) => Promise<string | null>

async function loadModule() {
  const mod = await import('./projects.js')
  discoverProjects = mod.discoverProjects
  resolveProject = mod.resolveProject
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
