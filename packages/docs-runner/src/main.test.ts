import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main, parseArgv, runInit } from './main.js'

describe('docs-runner main: argv parsing', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit_${code ?? 0}`)
    }) as unknown as ReturnType<typeof vi.spyOn>
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true) as unknown as ReturnType<typeof vi.spyOn>
  })

  afterEach(() => {
    exitSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('exits 2 with usage on wrong arity', () => {
    expect(() => parseArgv(['only', 'three', 'args'])).toThrow(/exit_2/)
    const calls = (stderrSpy.mock.calls as unknown[][]).map((c) => String(c[0]))
    expect(calls.some((c) => c.includes('expected 5 positional args'))).toBe(true)
  })

  it('returns the parsed argv on the happy path', () => {
    const argv = parseArgv(['proj', 'cmd.json', 'pid.json', 'exit.json', 'meta.json'])
    expect(argv).toEqual({
      projectId: 'proj',
      cmdFile: 'cmd.json',
      pidFile: 'pid.json',
      exitFile: 'exit.json',
      metaFile: 'meta.json',
    })
  })
})

describe('docs-runner main: cmd-file parse failure', () => {
  let dir: string
  let exitSpy: ReturnType<typeof vi.spyOn>
  const originalArgv = process.argv

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'duraclaw-docs-main-'))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit_${code ?? 0}`)
    }) as unknown as ReturnType<typeof vi.spyOn>
  })

  afterEach(async () => {
    process.argv = originalArgv
    exitSpy.mockRestore()
    await rm(dir, { recursive: true, force: true })
  })

  it('writes exit-file with state=failed when cmd-file is missing', async () => {
    const cmdFile = join(dir, 'missing.json')
    const pidFile = join(dir, 'pid.json')
    const exitFile = join(dir, 'exit.json')
    const metaFile = join(dir, 'meta.json')

    process.argv = ['bun', 'main.ts', 'proj', cmdFile, pidFile, exitFile, metaFile]
    await expect(main()).rejects.toThrow(/exit_1/)

    const raw = await readFile(exitFile, 'utf8')
    const payload = JSON.parse(raw) as { state: string; exit_code: number; error?: string }
    expect(payload.state).toBe('failed')
    expect(payload.exit_code).toBe(1)
    expect(payload.error).toMatch(/cmd-file unreadable/)
  })

  it('writes exit-file when cmd.type is wrong', async () => {
    const cmdFile = join(dir, 'cmd.json')
    const pidFile = join(dir, 'pid.json')
    const exitFile = join(dir, 'exit.json')
    const metaFile = join(dir, 'meta.json')

    const { writeFile } = await import('node:fs/promises')
    await writeFile(cmdFile, JSON.stringify({ type: 'execute', sessionId: 'wrong' }))

    process.argv = ['bun', 'main.ts', 'proj', cmdFile, pidFile, exitFile, metaFile]
    await expect(main()).rejects.toThrow(/exit_1/)

    const raw = await readFile(exitFile, 'utf8')
    const payload = JSON.parse(raw) as { state: string; error?: string }
    expect(payload.state).toBe('failed')
    expect(payload.error).toMatch(/unsupported cmd.type/)
  })
})

describe('docs-runner main: init subcommand', () => {
  let dir: string
  let exitSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  const originalArgv = process.argv

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'duraclaw-docs-init-'))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit_${code ?? 0}`)
    }) as unknown as ReturnType<typeof vi.spyOn>
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true) as unknown as ReturnType<typeof vi.spyOn>
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true) as unknown as ReturnType<typeof vi.spyOn>
  })

  afterEach(async () => {
    process.argv = originalArgv
    exitSpy.mockRestore()
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    await rm(dir, { recursive: true, force: true })
  })

  it('writes default yaml when worktree exists and config is absent', async () => {
    // Pre-create .git so worktree-bootstrap step is skipped.
    await mkdir(join(dir, '.git'), { recursive: true })

    await expect(runInit(dir)).rejects.toThrow(/exit_0/)

    const cfg = await readFile(join(dir, 'duraclaw-docs.yaml'), 'utf8')
    expect(cfg).toMatch(/watch:/)
    expect(cfg).toMatch(/tombstone_grace_days: 7/)
  })

  it('refuses to overwrite an existing config file', async () => {
    await mkdir(join(dir, '.git'), { recursive: true })
    const cfgPath = join(dir, 'duraclaw-docs.yaml')
    await writeFile(cfgPath, '# custom')

    await expect(runInit(dir)).rejects.toThrow(/exit_0/)

    const after = await readFile(cfgPath, 'utf8')
    expect(after).toBe('# custom')
    const calls = (stderrSpy.mock.calls as unknown[][]).map((c) => String(c[0]))
    expect(calls.some((c) => c.includes('refusing to overwrite'))).toBe(true)
  })

  it('exits 2 with usage when path arg is missing', async () => {
    process.argv = ['bun', 'main.ts', 'init']
    await expect(main()).rejects.toThrow(/exit_2/)
    const calls = (stderrSpy.mock.calls as unknown[][]).map((c) => String(c[0]))
    expect(calls.some((c) => c.includes('usage: docs-runner init'))).toBe(true)
  })
})
