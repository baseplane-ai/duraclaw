import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertWithinRoot } from './path-safety.js'

describe('assertWithinRoot', () => {
  const root = '/data/projects/duraclaw'

  it('accepts a simple relative file', () => {
    expect(assertWithinRoot(root, 'foo.md')).toBe(`${root}/foo.md`)
  })

  it('accepts a leading-./  relative file', () => {
    expect(assertWithinRoot(root, './foo.md')).toBe(`${root}/foo.md`)
  })

  it('rejects empty relPath', () => {
    expect(() => assertWithinRoot(root, '')).toThrow('empty relPath')
  })

  it('rejects ../ traversal', () => {
    expect(() => assertWithinRoot(root, '../foo.md')).toThrow('path escapes worktree root')
  })

  it('rejects absolute paths that resolve outside root', () => {
    expect(() => assertWithinRoot(root, '/etc/passwd')).toThrow('path escapes worktree root')
  })

  it('accepts internal traversal that resolves cleanly inside root', () => {
    expect(assertWithinRoot(root, 'foo/../bar.md')).toBe(`${root}/bar.md`)
  })

  it('rejects nested traversal that escapes root', () => {
    expect(() => assertWithinRoot(root, 'foo/../../bar.md')).toThrow('path escapes worktree root')
  })

  it('rejects sibling-prefix bypass (foo/../<basename>-other/bar.md)', () => {
    const basename = path.basename(root)
    const evil = `foo/../../${basename}-other/bar.md`
    expect(() => assertWithinRoot(root, evil)).toThrow('path escapes worktree root')
  })

  it('includes relPath in the error message', () => {
    expect(() => assertWithinRoot(root, '../escape')).toThrow('relPath=../escape')
  })
})
