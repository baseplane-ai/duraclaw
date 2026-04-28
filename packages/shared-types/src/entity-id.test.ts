import { describe, expect, test } from 'vitest'
import { DOCS_YDOC_FRAGMENT_NAME, deriveEntityId, deriveProjectId } from './entity-id.js'

describe('entity-id derivation (#27 B2)', () => {
  test('deriveProjectId returns 16 lowercase-hex chars and is deterministic', async () => {
    const ssh = 'git@github.com:foo/bar.git'
    const a = await deriveProjectId(ssh)
    const b = await deriveProjectId(ssh)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  test('different remote URLs produce different projectIds', async () => {
    const ssh = await deriveProjectId('git@github.com:foo/bar.git')
    const https = await deriveProjectId('https://github.com/foo/bar.git')
    expect(ssh).not.toBe(https)
    expect(https).toMatch(/^[0-9a-f]{16}$/)
  })

  test('deriveEntityId is path-sensitive within the same projectId', async () => {
    const projectId = 'abcd1234abcd1234'
    const foo = await deriveEntityId(projectId, 'planning/foo.md')
    const bar = await deriveEntityId(projectId, 'planning/bar.md')
    expect(foo).toMatch(/^[0-9a-f]{16}$/)
    expect(bar).toMatch(/^[0-9a-f]{16}$/)
    expect(foo).not.toBe(bar)
  })

  test('DOCS_YDOC_FRAGMENT_NAME is the canonical document-store key', () => {
    expect(DOCS_YDOC_FRAGMENT_NAME).toBe('document-store')
  })
})
