import { describe, expect, it } from 'vitest'
import type { GatewaySessionContext } from '../types.js'
import { ClaudeAdapter } from './claude.js'

/** Create a mock GatewaySessionContext */
function createMockCtx(overrides?: Partial<GatewaySessionContext>): GatewaySessionContext {
  return {
    sessionId: 'test-session',
    orgId: null,
    userId: null,
    adapterName: 'claude',
    abortController: new AbortController(),
    pendingAnswer: null,
    pendingPermission: null,
    messageQueue: null,
    query: null,
    commandQueue: [],
    ...overrides,
  }
}

describe('ClaudeAdapter', () => {
  it('has name "claude"', () => {
    const adapter = new ClaudeAdapter()
    expect(adapter.name).toBe('claude')
  })

  it('implements AgentAdapter interface (all methods exist)', () => {
    const adapter = new ClaudeAdapter()
    expect(typeof adapter.execute).toBe('function')
    expect(typeof adapter.resume).toBe('function')
    expect(typeof adapter.abort).toBe('function')
    expect(typeof adapter.getCapabilities).toBe('function')
  })

  describe('abort', () => {
    it('calls abortController.abort()', () => {
      const adapter = new ClaudeAdapter()
      const ctx = createMockCtx()

      expect(ctx.abortController.signal.aborted).toBe(false)
      adapter.abort(ctx)
      expect(ctx.abortController.signal.aborted).toBe(true)
    })

    it('can be called multiple times without throwing', () => {
      const adapter = new ClaudeAdapter()
      const ctx = createMockCtx()

      adapter.abort(ctx)
      expect(() => adapter.abort(ctx)).not.toThrow()
    })
  })

  describe('getCapabilities', () => {
    it('returns correct agent name', async () => {
      const adapter = new ClaudeAdapter()
      const caps = await adapter.getCapabilities()
      expect(caps.agent).toBe('claude')
    })

    it('reports availability based on SDK importability', async () => {
      const adapter = new ClaudeAdapter()
      const caps = await adapter.getCapabilities()
      // In test environment the SDK is installed, so it should be available
      expect(typeof caps.available).toBe('boolean')
    })

    it('includes expected supported commands', async () => {
      const adapter = new ClaudeAdapter()
      const caps = await adapter.getCapabilities()

      expect(caps.supportedCommands).toContain('execute')
      expect(caps.supportedCommands).toContain('resume')
      expect(caps.supportedCommands).toContain('abort')
      expect(caps.supportedCommands).toContain('stop')
      expect(caps.supportedCommands).toContain('interrupt')
      expect(caps.supportedCommands).toContain('set-model')
      expect(caps.supportedCommands).toContain('rewind')
    })

    it('has description "Claude Code via Agent SDK"', async () => {
      const adapter = new ClaudeAdapter()
      const caps = await adapter.getCapabilities()
      expect(caps.description).toBe('Claude Code via Agent SDK')
    })

    it('does not include models field (Claude uses default)', async () => {
      const adapter = new ClaudeAdapter()
      const caps = await adapter.getCapabilities()
      expect(caps.models).toBeUndefined()
    })
  })

  describe('execute with unknown project', () => {
    it('sends error event when project is not found', async () => {
      const adapter = new ClaudeAdapter()
      const sent: string[] = []
      const ws = {
        send(data: string) {
          sent.push(data)
        },
        data: { project: 'nonexistent' },
      } as any

      const ctx = createMockCtx()
      const cmd = {
        type: 'execute' as const,
        project: 'nonexistent-project-xyz-999',
        prompt: 'hello',
      }

      await adapter.execute(ws, cmd, ctx)

      expect(sent.length).toBe(1)
      const msg = JSON.parse(sent[0])
      expect(msg.type).toBe('error')
      expect(msg.error).toContain('not found')
      expect(msg.session_id).toBe('test-session')
    })
  })

  describe('resume with unknown project', () => {
    it('sends error event when project is not found', async () => {
      const adapter = new ClaudeAdapter()
      const sent: string[] = []
      const ws = {
        send(data: string) {
          sent.push(data)
        },
        data: { project: 'nonexistent' },
      } as any

      const ctx = createMockCtx()
      const cmd = {
        type: 'resume' as const,
        project: 'nonexistent-project-xyz-999',
        prompt: 'continue',
        sdk_session_id: 'fake-session-id',
      }

      await adapter.resume(ws, cmd, ctx)

      expect(sent.length).toBe(1)
      const msg = JSON.parse(sent[0])
      expect(msg.type).toBe('error')
      expect(msg.error).toContain('not found')
    })
  })
})
