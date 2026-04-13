import { describe, expect, it } from 'vitest'
import { CodexSessionSource } from './codex.js'

describe('CodexSessionSource', () => {
  it('has agent set to codex', () => {
    const source = new CodexSessionSource()
    expect(source.agent).toBe('codex')
  })

  it('has a description', () => {
    const source = new CodexSessionSource()
    expect(source.description).toBeTruthy()
    expect(typeof source.description).toBe('string')
  })

  it('available() returns false (stub)', async () => {
    const source = new CodexSessionSource()
    expect(await source.available()).toBe(false)
  })

  it('discoverSessions() returns empty array (stub)', async () => {
    const source = new CodexSessionSource()
    const sessions = await source.discoverSessions('/tmp/some-project')
    expect(sessions).toEqual([])
  })
})
