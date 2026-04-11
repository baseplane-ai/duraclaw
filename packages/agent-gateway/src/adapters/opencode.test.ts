import { describe, expect, it } from 'vitest'
import type { GatewaySessionContext } from '../types.js'
import {
  normalizePartToContent,
  normalizePartToToolResult,
  OpenCodeAdapter,
  parseModelSpec,
} from './opencode.js'

/** Create a mock GatewaySessionContext */
function createMockCtx(overrides?: Partial<GatewaySessionContext>): GatewaySessionContext {
  return {
    sessionId: 'test-session',
    orgId: null,
    userId: null,
    adapterName: 'opencode',
    abortController: new AbortController(),
    pendingAnswer: null,
    pendingPermission: null,
    messageQueue: null,
    query: null,
    commandQueue: [],
    ...overrides,
  }
}

/** Create a mock WebSocket that records sent messages. */
function createMockWs() {
  const sent: string[] = []
  const ws = {
    send(data: string) {
      sent.push(data)
    },
    data: { project: 'test' },
  } as any
  return { ws, sent, parsedMessages: () => sent.map((s) => JSON.parse(s)) }
}

describe('OpenCodeAdapter', () => {
  it('has name "opencode"', () => {
    const adapter = new OpenCodeAdapter()
    expect(adapter.name).toBe('opencode')
  })

  it('implements AgentAdapter interface (all methods exist)', () => {
    const adapter = new OpenCodeAdapter()
    expect(typeof adapter.execute).toBe('function')
    expect(typeof adapter.resume).toBe('function')
    expect(typeof adapter.abort).toBe('function')
    expect(typeof adapter.getCapabilities).toBe('function')
  })

  describe('abort', () => {
    it('calls abortController.abort()', () => {
      const adapter = new OpenCodeAdapter()
      const ctx = createMockCtx()

      expect(ctx.abortController.signal.aborted).toBe(false)
      adapter.abort(ctx)
      expect(ctx.abortController.signal.aborted).toBe(true)
    })

    it('can be called multiple times without throwing', () => {
      const adapter = new OpenCodeAdapter()
      const ctx = createMockCtx()

      adapter.abort(ctx)
      expect(() => adapter.abort(ctx)).not.toThrow()
    })
  })

  describe('getCapabilities', () => {
    it('returns correct agent name', async () => {
      const adapter = new OpenCodeAdapter()
      const caps = await adapter.getCapabilities()
      expect(caps.agent).toBe('opencode')
    })

    it('returns correct shape', async () => {
      const adapter = new OpenCodeAdapter()
      const caps = await adapter.getCapabilities()
      expect(typeof caps.available).toBe('boolean')
      expect(Array.isArray(caps.supportedCommands)).toBe(true)
      expect(typeof caps.description).toBe('string')
    })

    it('includes expected supported commands', async () => {
      const adapter = new OpenCodeAdapter()
      const caps = await adapter.getCapabilities()

      expect(caps.supportedCommands).toContain('execute')
      expect(caps.supportedCommands).toContain('abort')
    })

    it('does not include Claude-specific commands', async () => {
      const adapter = new OpenCodeAdapter()
      const caps = await adapter.getCapabilities()

      expect(caps.supportedCommands).not.toContain('interrupt')
      expect(caps.supportedCommands).not.toContain('set-model')
      expect(caps.supportedCommands).not.toContain('rewind')
      expect(caps.supportedCommands).not.toContain('stop')
    })

    it('does not include resume in supported commands', async () => {
      const adapter = new OpenCodeAdapter()
      const caps = await adapter.getCapabilities()
      expect(caps.supportedCommands).not.toContain('resume')
    })

    it('has description "OpenCode multi-provider agent"', async () => {
      const adapter = new OpenCodeAdapter()
      const caps = await adapter.getCapabilities()
      expect(caps.description).toBe('OpenCode multi-provider agent')
    })

    it('reports available=false when sidecar is not running', async () => {
      // By default the sidecar is not running in test env
      const adapter = new OpenCodeAdapter()
      const caps = await adapter.getCapabilities()
      // Unless OPENCODE_URL points to a running instance, should be false
      if (!process.env.OPENCODE_URL) {
        expect(caps.available).toBe(false)
      }
    })
  })
})

describe('parseModelSpec', () => {
  it('returns undefined for undefined input', () => {
    expect(parseModelSpec(undefined)).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(parseModelSpec('')).toBeUndefined()
  })

  it('parses provider/model format', () => {
    const result = parseModelSpec('anthropic/claude-sonnet-4-20250514')
    expect(result).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-20250514',
    })
  })

  it('parses openai/gpt-4o format', () => {
    const result = parseModelSpec('openai/gpt-4o')
    expect(result).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o',
    })
  })

  it('defaults to anthropic provider when no slash', () => {
    const result = parseModelSpec('claude-sonnet-4-20250514')
    expect(result).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-20250514',
    })
  })

  it('handles multiple slashes correctly (first slash is separator)', () => {
    const result = parseModelSpec('provider/model/variant')
    expect(result).toEqual({
      providerID: 'provider',
      modelID: 'model/variant',
    })
  })
})

describe('normalizePartToContent', () => {
  it('normalizes text part to text content', () => {
    const result = normalizePartToContent({
      type: 'text',
      id: 'part-1',
      text: 'Hello world',
    })
    expect(result).toEqual([{ type: 'text', text: 'Hello world' }])
  })

  it('normalizes text part with missing text to empty string', () => {
    const result = normalizePartToContent({
      type: 'text',
      id: 'part-2',
    })
    expect(result).toEqual([{ type: 'text', text: '' }])
  })

  it('normalizes reasoning part to text content', () => {
    const result = normalizePartToContent({
      type: 'reasoning',
      id: 'reason-1',
      text: 'Let me think...',
    })
    expect(result).toEqual([{ type: 'text', text: 'Let me think...' }])
  })

  it('normalizes tool part to tool_use content', () => {
    const result = normalizePartToContent({
      type: 'tool',
      id: 'tool-1',
      tool: 'bash',
      callID: 'call-1',
      state: {
        status: 'completed',
        input: { command: 'ls -la' },
        output: 'file1.ts',
      },
    })
    expect(result).toEqual([
      {
        type: 'tool_use',
        name: 'bash',
        input: { command: 'ls -la' },
      },
    ])
  })

  it('normalizes tool part with missing state to empty array', () => {
    const result = normalizePartToContent({
      type: 'tool',
      id: 'tool-2',
      tool: 'bash',
    })
    expect(result).toEqual([])
  })

  it('normalizes tool part with missing tool name to "unknown"', () => {
    const result = normalizePartToContent({
      type: 'tool',
      id: 'tool-3',
      state: {
        status: 'completed',
        input: {},
      },
    })
    expect(result).toEqual([
      {
        type: 'tool_use',
        name: 'unknown',
        input: {},
      },
    ])
  })

  it('handles unknown part types gracefully', () => {
    const result = normalizePartToContent({
      type: 'snapshot',
      id: 'snap-1',
    })
    expect(result).toEqual([{ type: 'text', text: '[snapshot]' }])
  })
})

describe('normalizePartToToolResult', () => {
  it('returns empty array for non-tool parts', () => {
    const result = normalizePartToToolResult({
      type: 'text',
      id: 'part-1',
    })
    expect(result).toEqual([])
  })

  it('normalizes completed tool to output text', () => {
    const result = normalizePartToToolResult({
      type: 'tool',
      id: 'tool-1',
      tool: 'bash',
      state: {
        status: 'completed',
        output: 'file1.ts\nfile2.ts',
      },
    })
    expect(result).toEqual([{ type: 'text', text: 'file1.ts\nfile2.ts' }])
  })

  it('normalizes completed tool with empty output', () => {
    const result = normalizePartToToolResult({
      type: 'tool',
      id: 'tool-2',
      tool: 'bash',
      state: {
        status: 'completed',
      },
    })
    expect(result).toEqual([{ type: 'text', text: '' }])
  })

  it('normalizes error tool to error text', () => {
    const result = normalizePartToToolResult({
      type: 'tool',
      id: 'tool-3',
      tool: 'bash',
      state: {
        status: 'error',
        error: 'Command failed',
      },
    })
    expect(result).toEqual([{ type: 'text', text: 'Error: Command failed' }])
  })

  it('normalizes error tool with missing error message', () => {
    const result = normalizePartToToolResult({
      type: 'tool',
      id: 'tool-4',
      tool: 'bash',
      state: {
        status: 'error',
      },
    })
    expect(result).toEqual([{ type: 'text', text: 'Error: ' }])
  })

  it('normalizes tool with missing state to "completed"', () => {
    const result = normalizePartToToolResult({
      type: 'tool',
      id: 'tool-5',
    })
    expect(result).toEqual([{ type: 'text', text: 'completed' }])
  })
})

describe('OpenCodeAdapter execute error handling', () => {
  it('sends error event when SDK import fails (sidecar not reachable)', async () => {
    // The execute path will fail because no OpenCode sidecar is running.
    // This tests the catch block in runSession.
    const adapter = new OpenCodeAdapter()
    const { ws, parsedMessages } = createMockWs()

    const ctx = createMockCtx()
    const cmd = {
      type: 'execute' as const,
      project: 'test-project',
      prompt: 'hello',
      agent: 'opencode',
    }

    await adapter.execute(ws, cmd, ctx)

    const msgs = parsedMessages()
    // Should have received an error (either SDK import failure or connection refused)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    const errorMsgs = msgs.filter((m: any) => m.type === 'error')
    expect(errorMsgs.length).toBeGreaterThanOrEqual(1)
    expect(errorMsgs[0].session_id).toBe('test-session')
    expect(typeof errorMsgs[0].error).toBe('string')
  })

  it('does not send error when abortController is already aborted', async () => {
    const adapter = new OpenCodeAdapter()
    const { ws, parsedMessages } = createMockWs()

    const ctx = createMockCtx()
    // Abort before execute so the catch block checks ac.signal.aborted
    ctx.abortController.abort()

    const cmd = {
      type: 'execute' as const,
      project: 'test-project',
      prompt: 'hello',
      agent: 'opencode',
    }

    await adapter.execute(ws, cmd, ctx)

    const msgs = parsedMessages()
    // Should NOT have any error messages since abort was signaled
    const errorMsgs = msgs.filter((m: any) => m.type === 'error')
    expect(errorMsgs).toHaveLength(0)
  })
})

describe('OpenCodeAdapter resume', () => {
  it('resume delegates to the same runSession method as execute', () => {
    // Verify that resume() exists and is callable.
    // Full integration testing requires a running OpenCode sidecar.
    const adapter = new OpenCodeAdapter()
    expect(typeof adapter.resume).toBe('function')
    // The resume method takes the same parameters as execute
    expect(adapter.resume.length).toBe(adapter.execute.length)
  })
})

describe('OpenCodeAdapter server wiring', () => {
  // Note: Cannot import server.ts directly in vitest because it uses Bun globals.
  // Instead we verify the adapter is properly exported and can be registered.
  it('OpenCodeAdapter can be instantiated and registered alongside other adapters', async () => {
    const {
      AdapterRegistry,
      ClaudeAdapter,
      CodexAdapter,
      OpenCodeAdapter: OCA,
    } = await import('./index.js')
    const registry = new AdapterRegistry()
    registry.register(new ClaudeAdapter())
    registry.register(new CodexAdapter())
    registry.register(new OCA())

    expect(registry.get('opencode')).toBeDefined()
    expect(registry.get('opencode')!.name).toBe('opencode')
    expect(registry.listNames()).toHaveLength(3)
  })
})

describe('normalizePartToContent edge cases', () => {
  it('normalizes tool part with state but empty input', () => {
    const result = normalizePartToContent({
      type: 'tool',
      id: 'tool-edge-1',
      tool: 'edit',
      state: {
        status: 'running',
      },
    })
    expect(result).toEqual([
      {
        type: 'tool_use',
        name: 'edit',
        input: {},
      },
    ])
  })

  it('normalizes step-start as unknown type', () => {
    const result = normalizePartToContent({
      type: 'step-start',
      id: 'step-1',
    })
    expect(result).toEqual([{ type: 'text', text: '[step-start]' }])
  })

  it('normalizes step-finish as unknown type', () => {
    const result = normalizePartToContent({
      type: 'step-finish',
      id: 'step-2',
    })
    expect(result).toEqual([{ type: 'text', text: '[step-finish]' }])
  })

  it('normalizes compaction as unknown type', () => {
    const result = normalizePartToContent({
      type: 'compaction',
      id: 'compact-1',
    })
    expect(result).toEqual([{ type: 'text', text: '[compaction]' }])
  })

  it('normalizes subtask as unknown type', () => {
    const result = normalizePartToContent({
      type: 'subtask',
      id: 'sub-1',
    })
    expect(result).toEqual([{ type: 'text', text: '[subtask]' }])
  })
})

describe('normalizePartToToolResult edge cases', () => {
  it('returns empty array for reasoning part', () => {
    const result = normalizePartToToolResult({
      type: 'reasoning',
      id: 'reason-1',
    })
    expect(result).toEqual([])
  })

  it('returns empty array for step-start part', () => {
    const result = normalizePartToToolResult({
      type: 'step-start',
      id: 'step-1',
    })
    expect(result).toEqual([])
  })

  it('normalizes running tool status to output text', () => {
    const result = normalizePartToToolResult({
      type: 'tool',
      id: 'tool-running',
      tool: 'bash',
      state: {
        status: 'running',
        output: 'partial output',
      },
    })
    // Running status is not 'error', so falls through to the output path
    expect(result).toEqual([{ type: 'text', text: 'partial output' }])
  })

  it('normalizes pending tool status to empty output', () => {
    const result = normalizePartToToolResult({
      type: 'tool',
      id: 'tool-pending',
      tool: 'bash',
      state: {
        status: 'pending',
      },
    })
    // Pending status is not 'error', output is undefined -> ''
    expect(result).toEqual([{ type: 'text', text: '' }])
  })
})

describe('OpenCodeAdapter registry wiring', () => {
  it('OpenCodeAdapter is exported from adapters index', async () => {
    const { OpenCodeAdapter: Imported } = await import('./index.js')
    expect(Imported).toBeDefined()
    const adapter = new Imported()
    expect(adapter.name).toBe('opencode')
  })

  it('AdapterRegistry can register and retrieve OpenCodeAdapter', async () => {
    const { AdapterRegistry } = await import('./registry.js')
    const registry = new AdapterRegistry()
    const adapter = new OpenCodeAdapter()
    registry.register(adapter)

    expect(registry.get('opencode')).toBe(adapter)
    expect(registry.get('opencode')!.name).toBe('opencode')
  })

  it('OpenCodeAdapter coexists with ClaudeAdapter and CodexAdapter in registry', async () => {
    const {
      AdapterRegistry,
      ClaudeAdapter,
      CodexAdapter,
      OpenCodeAdapter: Imported,
    } = await import('./index.js')
    const registry = new AdapterRegistry()
    registry.register(new ClaudeAdapter())
    registry.register(new CodexAdapter())
    registry.register(new Imported())

    const names = registry.listNames()
    expect(names).toContain('claude')
    expect(names).toContain('codex')
    expect(names).toContain('opencode')
    expect(names).toHaveLength(3)
  })

  it('OpenCodeAdapter capabilities appear in registry listCapabilities', async () => {
    const { AdapterRegistry } = await import('./index.js')
    const registry = new AdapterRegistry()
    registry.register(new OpenCodeAdapter())

    const caps = await registry.listCapabilities()
    expect(caps).toHaveLength(1)
    expect(caps[0].agent).toBe('opencode')
    expect(caps[0].supportedCommands).toContain('execute')
    expect(caps[0].description).toBe('OpenCode multi-provider agent')
  })
})
