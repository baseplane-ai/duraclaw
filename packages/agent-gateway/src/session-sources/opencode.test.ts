import { describe, expect, it } from 'vitest'
import { OpenCodeSessionSource } from './opencode.js'

describe('OpenCodeSessionSource', () => {
  it('has agent set to opencode', () => {
    const source = new OpenCodeSessionSource()
    expect(source.agent).toBe('opencode')
  })

  it('has a description', () => {
    const source = new OpenCodeSessionSource()
    expect(source.description).toBeTruthy()
    expect(typeof source.description).toBe('string')
  })

  it('available() returns false (stub)', async () => {
    const source = new OpenCodeSessionSource()
    expect(await source.available()).toBe(false)
  })

  it('discoverSessions() returns empty array (stub)', async () => {
    const source = new OpenCodeSessionSource()
    const sessions = await source.discoverSessions('/tmp/some-project')
    expect(sessions).toEqual([])
  })
})
