import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleFileContents, handleFileTree, handleGitStatus } from './files.js'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-gateway-test-'))
  // Create test file structure
  await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true })
  await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name":"test"}')
  await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), 'export const hello = "world"')
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test Project')
  // Create a large file for size limit test
  const largeContent = 'x'.repeat(2 * 1024 * 1024) // 2MB
  await fs.writeFile(path.join(tmpDir, 'large-file.bin'), largeContent)
})

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('handleFileTree', () => {
  it('returns directory entries at root', async () => {
    const params = new URLSearchParams({ depth: '1', path: '/' })
    const res = await handleFileTree(tmpDir, params)
    const data = (await res.json()) as any

    expect(res.status).toBe(200)
    expect(data.entries).toBeDefined()
    expect(data.entries.length).toBeGreaterThan(0)

    // Should have src dir and files
    const names = data.entries.map((e: any) => e.name)
    expect(names).toContain('src')
    expect(names).toContain('package.json')
    expect(names).toContain('README.md')
  })

  it('sorts directories before files', async () => {
    const params = new URLSearchParams({ depth: '1', path: '/' })
    const res = await handleFileTree(tmpDir, params)
    const data = (await res.json()) as any

    const dirs = data.entries.filter((e: any) => e.type === 'dir')
    const files = data.entries.filter((e: any) => e.type === 'file')
    const firstFileIndex = data.entries.findIndex((e: any) => e.type === 'file')
    const lastDirIndex =
      data.entries.length - 1 - [...data.entries].reverse().findIndex((e: any) => e.type === 'dir')

    if (dirs.length > 0 && files.length > 0) {
      expect(lastDirIndex).toBeLessThan(firstFileIndex)
    }
  })

  it('hides hidden files except .github', async () => {
    const params = new URLSearchParams({ depth: '1', path: '/' })
    const res = await handleFileTree(tmpDir, params)
    const data = (await res.json()) as any

    const names = data.entries.map((e: any) => e.name)
    expect(names).not.toContain('.git')
  })

  it('rejects path traversal', async () => {
    const params = new URLSearchParams({ depth: '1', path: '../../etc' })
    const res = await handleFileTree(tmpDir, params)
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error).toContain('traversal')
  })

  it('returns 404 for non-existent path', async () => {
    const params = new URLSearchParams({ depth: '1', path: 'nonexistent' })
    const res = await handleFileTree(tmpDir, params)
    expect(res.status).toBe(404)
  })
})

describe('handleFileContents', () => {
  it('returns file contents', async () => {
    const res = await handleFileContents(tmpDir, 'package.json')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe('{"name":"test"}')
  })

  it('returns correct content-type for JSON', async () => {
    const res = await handleFileContents(tmpDir, 'package.json')
    expect(res.headers.get('Content-Type')).toBe('application/json')
  })

  it('returns correct content-type for TypeScript', async () => {
    const res = await handleFileContents(tmpDir, 'src/index.ts')
    expect(res.headers.get('Content-Type')).toBe('text/typescript')
  })

  it('returns correct content-type for Markdown', async () => {
    const res = await handleFileContents(tmpDir, 'README.md')
    expect(res.headers.get('Content-Type')).toBe('text/markdown')
  })

  it('rejects path traversal with ..', async () => {
    const res = await handleFileContents(tmpDir, '../../../etc/passwd')
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error).toContain('traversal')
  })

  it('returns 413 for files over 1MB', async () => {
    const res = await handleFileContents(tmpDir, 'large-file.bin')
    expect(res.status).toBe(413)
  })

  it('returns 404 for missing files', async () => {
    const res = await handleFileContents(tmpDir, 'nonexistent.txt')
    expect(res.status).toBe(404)
  })

  it('returns 400 for directories', async () => {
    const res = await handleFileContents(tmpDir, 'src')
    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error).toContain('directory')
  })
})

describe('handleGitStatus', () => {
  it('returns git status for a git repo', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)

    // Remove the fake .git dir and init a real one
    await fs.rm(path.join(tmpDir, '.git'), { recursive: true })
    await exec('git', ['init'], { cwd: tmpDir })
    await exec('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
    await exec('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    await exec('git', ['add', 'package.json'], { cwd: tmpDir })
    await exec('git', ['commit', '-m', 'init'], { cwd: tmpDir })

    // Now src/index.ts, README.md, large-file.bin should be untracked
    const res = await handleGitStatus(tmpDir)
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.files).toBeDefined()
    expect(Array.isArray(data.files)).toBe(true)

    // Should have untracked files
    const untracked = data.files.filter((f: any) => f.status === 'untracked')
    expect(untracked.length).toBeGreaterThan(0)
  })
})
