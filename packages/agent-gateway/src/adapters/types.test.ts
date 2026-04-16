import type { ExecuteCommand, ResumeCommand } from '@duraclaw/shared-types'
import { describe, expect, it } from 'vitest'
import type { SessionChannel } from '../session-channel.js'
import type { DiscoveredSession, GatewaySessionContext, SessionSource } from '../types.js'
import type { AdapterCapabilities, AgentAdapter } from './types.js'

/**
 * A no-op mock adapter that satisfies the AgentAdapter interface.
 * Used to verify the interface compiles and a concrete implementation type-checks.
 */
class MockAdapter implements AgentAdapter {
  readonly name = 'mock'

  async execute(
    _ch: SessionChannel,
    _cmd: ExecuteCommand,
    _ctx: GatewaySessionContext,
  ): Promise<void> {
    // no-op
  }

  async resume(
    _ch: SessionChannel,
    _cmd: ResumeCommand,
    _ctx: GatewaySessionContext,
  ): Promise<void> {
    // no-op
  }

  abort(_ctx: GatewaySessionContext): void {
    // no-op
  }

  async getCapabilities(): Promise<AdapterCapabilities> {
    return {
      agent: 'mock',
      available: true,
      supportedCommands: ['execute'],
      description: 'Mock adapter for testing',
    }
  }
}

describe('AgentAdapter interface', () => {
  it('can be implemented by a concrete class', () => {
    const adapter: AgentAdapter = new MockAdapter()
    expect(adapter.name).toBe('mock')
  })

  it('execute returns a Promise<void>', async () => {
    const adapter = new MockAdapter()
    const result = adapter.execute({} as any, {} as any, {} as any)
    expect(result).toBeInstanceOf(Promise)
    await result
  })

  it('resume returns a Promise<void>', async () => {
    const adapter = new MockAdapter()
    const result = adapter.resume({} as any, {} as any, {} as any)
    expect(result).toBeInstanceOf(Promise)
    await result
  })

  it('abort is synchronous and does not throw', () => {
    const adapter = new MockAdapter()
    expect(() => adapter.abort({} as any)).not.toThrow()
  })

  it('getCapabilities returns well-formed AdapterCapabilities', async () => {
    const adapter = new MockAdapter()
    const caps = await adapter.getCapabilities()

    expect(caps.agent).toBe('mock')
    expect(caps.available).toBe(true)
    expect(caps.supportedCommands).toContain('execute')
    expect(typeof caps.description).toBe('string')
    expect(caps.description.length).toBeGreaterThan(0)
  })

  it('AdapterCapabilities models field is optional', async () => {
    const adapter = new MockAdapter()
    const caps = await adapter.getCapabilities()

    // models is not set, should be undefined
    expect(caps.models).toBeUndefined()
  })
})

describe('Session discovery re-exports from types.ts', () => {
  it('DiscoveredSession is re-exported and usable', () => {
    const session: DiscoveredSession = {
      sdk_session_id: 'sess-1',
      agent: 'claude',
      project_dir: '/data/projects/dev1',
      project: 'dev1',
      branch: 'main',
      started_at: '2026-04-12T00:00:00Z',
      last_activity: '2026-04-12T01:00:00Z',
      summary: 'test',
      tag: null,
      title: null,
      message_count: null,
      user: null,
    }
    expect(session.sdk_session_id).toBe('sess-1')
    expect(session.agent).toBe('claude')
  })

  it('SessionSource is re-exported and usable', async () => {
    const source: SessionSource = {
      agent: 'claude',
      description: 'Claude Code sessions',
      async available() {
        return true
      },
      async discoverSessions() {
        return []
      },
    }
    expect(source.agent).toBe('claude')
    expect(await source.available()).toBe(true)
    expect(await source.discoverSessions('/tmp')).toEqual([])
  })
})
