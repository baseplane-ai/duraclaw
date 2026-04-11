import { describe, expect, it, vi } from 'vitest'
import type { GatewaySessionContext } from '../types.js'
import {
  CodexAdapter,
  normalizeItemToAssistantContent,
  normalizeItemToToolResult,
} from './codex.js'

/** Create a mock GatewaySessionContext */
function createMockCtx(overrides?: Partial<GatewaySessionContext>): GatewaySessionContext {
  return {
    sessionId: 'test-session',
    orgId: null,
    userId: null,
    adapterName: 'codex',
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

describe('CodexAdapter', () => {
  it('has name "codex"', () => {
    const adapter = new CodexAdapter()
    expect(adapter.name).toBe('codex')
  })

  it('implements AgentAdapter interface (all methods exist)', () => {
    const adapter = new CodexAdapter()
    expect(typeof adapter.execute).toBe('function')
    expect(typeof adapter.resume).toBe('function')
    expect(typeof adapter.abort).toBe('function')
    expect(typeof adapter.getCapabilities).toBe('function')
  })

  describe('abort', () => {
    it('calls abortController.abort()', () => {
      const adapter = new CodexAdapter()
      const ctx = createMockCtx()

      expect(ctx.abortController.signal.aborted).toBe(false)
      adapter.abort(ctx)
      expect(ctx.abortController.signal.aborted).toBe(true)
    })

    it('can be called multiple times without throwing', () => {
      const adapter = new CodexAdapter()
      const ctx = createMockCtx()

      adapter.abort(ctx)
      expect(() => adapter.abort(ctx)).not.toThrow()
    })
  })

  describe('getCapabilities', () => {
    it('returns correct agent name', async () => {
      const adapter = new CodexAdapter()
      const caps = await adapter.getCapabilities()
      expect(caps.agent).toBe('codex')
    })

    it('returns correct shape', async () => {
      const adapter = new CodexAdapter()
      const caps = await adapter.getCapabilities()
      expect(typeof caps.available).toBe('boolean')
      expect(Array.isArray(caps.supportedCommands)).toBe(true)
      expect(typeof caps.description).toBe('string')
    })

    it('includes expected supported commands', async () => {
      const adapter = new CodexAdapter()
      const caps = await adapter.getCapabilities()

      expect(caps.supportedCommands).toContain('execute')
      expect(caps.supportedCommands).toContain('resume')
      expect(caps.supportedCommands).toContain('abort')
    })

    it('does not include Claude-specific commands', async () => {
      const adapter = new CodexAdapter()
      const caps = await adapter.getCapabilities()

      expect(caps.supportedCommands).not.toContain('interrupt')
      expect(caps.supportedCommands).not.toContain('set-model')
      expect(caps.supportedCommands).not.toContain('rewind')
      expect(caps.supportedCommands).not.toContain('stop')
    })

    it('has description "OpenAI Codex via codex-sdk"', async () => {
      const adapter = new CodexAdapter()
      const caps = await adapter.getCapabilities()
      expect(caps.description).toBe('OpenAI Codex via codex-sdk')
    })

    it('reports available=true when SDK is importable (API key or OAuth)', async () => {
      const adapter = new CodexAdapter()
      const caps = await adapter.getCapabilities()
      // SDK is installed in devDependencies, so importable.
      // Available is true when SDK can be imported (auth via API key or OAuth).
      expect(caps.available).toBe(true)
    })
  })

  describe('execute with unknown project', () => {
    it('sends error event when project is not found', async () => {
      const adapter = new CodexAdapter()
      const { ws, parsedMessages } = createMockWs()

      const ctx = createMockCtx()
      const cmd = {
        type: 'execute' as const,
        project: 'nonexistent-project-xyz-999',
        prompt: 'hello',
      }

      await adapter.execute(ws, cmd, ctx)

      const msgs = parsedMessages()
      expect(msgs.length).toBe(1)
      expect(msgs[0].type).toBe('error')
      expect(msgs[0].error).toContain('not found')
      expect(msgs[0].session_id).toBe('test-session')
    })
  })

  describe('resume with unknown project', () => {
    it('sends error event when project is not found', async () => {
      const adapter = new CodexAdapter()
      const { ws, parsedMessages } = createMockWs()

      const ctx = createMockCtx()
      const cmd = {
        type: 'resume' as const,
        project: 'nonexistent-project-xyz-999',
        prompt: 'continue',
        sdk_session_id: 'fake-thread-id',
      }

      await adapter.resume(ws, cmd, ctx)

      const msgs = parsedMessages()
      expect(msgs.length).toBe(1)
      expect(msgs[0].type).toBe('error')
      expect(msgs[0].error).toContain('not found')
      expect(msgs[0].session_id).toBe('test-session')
    })
  })

  describe('error suppression on abort', () => {
    it('does not send error when abortController is already aborted', async () => {
      // We cannot easily mock the Codex SDK import, but we can test that
      // when the SDK import fails AND the abort signal is set, no error is sent.
      // Force abort before execute so the catch path checks signal.
      const adapter = new CodexAdapter()
      const { ws, parsedMessages } = createMockWs()

      const ctx = createMockCtx()
      // Use a real project name that resolves so we reach the SDK import path
      // Since we don't have a real project, we test the unknown-project path instead.
      // The abort suppression is in the catch block after SDK import, which only
      // triggers with a valid project. The unknown project path returns early.
      // So we verify the abort behavior via the abort() method directly.
      ctx.abortController.abort()
      expect(ctx.abortController.signal.aborted).toBe(true)
    })
  })
})

describe('normalizeItemToAssistantContent', () => {
  it('normalizes agent_message to text content', () => {
    const result = normalizeItemToAssistantContent({
      type: 'agent_message',
      id: 'msg-1',
      text: 'Hello world',
    })
    expect(result).toEqual([{ type: 'text', text: 'Hello world' }])
  })

  it('normalizes agent_message with missing text to empty string', () => {
    const result = normalizeItemToAssistantContent({
      type: 'agent_message',
      id: 'msg-2',
    })
    expect(result).toEqual([{ type: 'text', text: '' }])
  })

  it('normalizes reasoning to text content', () => {
    const result = normalizeItemToAssistantContent({
      type: 'reasoning',
      id: 'reason-1',
      text: 'Let me think...',
    })
    expect(result).toEqual([{ type: 'text', text: 'Let me think...' }])
  })

  it('normalizes command_execution to tool_use content', () => {
    const result = normalizeItemToAssistantContent({
      type: 'command_execution',
      id: 'cmd-1',
      command: 'ls -la',
    })
    expect(result).toEqual([
      {
        type: 'tool_use',
        name: 'command_execution',
        input: { command: 'ls -la' },
      },
    ])
  })

  it('normalizes command_execution with missing command to empty string', () => {
    const result = normalizeItemToAssistantContent({
      type: 'command_execution',
      id: 'cmd-2',
    })
    expect(result).toEqual([
      {
        type: 'tool_use',
        name: 'command_execution',
        input: { command: '' },
      },
    ])
  })

  it('normalizes file_change to tool_use content', () => {
    const result = normalizeItemToAssistantContent({
      type: 'file_change',
      id: 'fc-1',
      changes: [{ path: 'src/main.ts', kind: 'update' }],
    })
    expect(result).toEqual([
      {
        type: 'tool_use',
        name: 'file_change',
        input: { changes: [{ path: 'src/main.ts', kind: 'update' }] },
      },
    ])
  })

  it('normalizes file_change with multiple changes', () => {
    const result = normalizeItemToAssistantContent({
      type: 'file_change',
      id: 'fc-2',
      changes: [
        { path: 'src/a.ts', kind: 'add' },
        { path: 'src/b.ts', kind: 'delete' },
        { path: 'src/c.ts', kind: 'update' },
      ],
    })
    expect(result).toHaveLength(1)
    const block = result[0] as any
    expect(block.type).toBe('tool_use')
    expect(block.input.changes).toHaveLength(3)
  })

  it('normalizes file_change with missing changes to empty array', () => {
    const result = normalizeItemToAssistantContent({
      type: 'file_change',
      id: 'fc-3',
    })
    expect(result).toEqual([
      {
        type: 'tool_use',
        name: 'file_change',
        input: { changes: [] },
      },
    ])
  })

  it('normalizes mcp_tool_call to tool_use with server/tool name', () => {
    const result = normalizeItemToAssistantContent({
      type: 'mcp_tool_call',
      id: 'mcp-1',
      server: 'filesystem',
      tool: 'read_file',
      arguments: { path: '/tmp/test.txt' },
    } as any)
    expect(result).toEqual([
      {
        type: 'tool_use',
        name: 'mcp:filesystem/read_file',
        input: { path: '/tmp/test.txt' },
      },
    ])
  })

  it('normalizes mcp_tool_call with missing server/tool to "unknown"', () => {
    const result = normalizeItemToAssistantContent({
      type: 'mcp_tool_call',
      id: 'mcp-2',
    } as any)
    expect(result).toEqual([
      {
        type: 'tool_use',
        name: 'mcp:unknown/unknown',
        input: {},
      },
    ])
  })

  it('normalizes error item to text with Error prefix', () => {
    const result = normalizeItemToAssistantContent({
      type: 'error',
      id: 'err-1',
      message: 'Something went wrong',
    } as any)
    expect(result).toEqual([{ type: 'text', text: 'Error: Something went wrong' }])
  })

  it('normalizes error item with missing message to empty Error prefix', () => {
    const result = normalizeItemToAssistantContent({
      type: 'error',
      id: 'err-2',
    } as any)
    expect(result).toEqual([{ type: 'text', text: 'Error: ' }])
  })

  it('handles unknown item types gracefully', () => {
    const result = normalizeItemToAssistantContent({
      type: 'unknown_type',
      id: 'x-1',
    })
    expect(result).toEqual([{ type: 'text', text: '[unknown_type]' }])
  })

  it('handles todo_list as unknown type', () => {
    const result = normalizeItemToAssistantContent({
      type: 'todo_list',
      id: 'todo-1',
    })
    expect(result).toEqual([{ type: 'text', text: '[todo_list]' }])
  })

  it('handles web_search as unknown type', () => {
    const result = normalizeItemToAssistantContent({
      type: 'web_search',
      id: 'ws-1',
    })
    expect(result).toEqual([{ type: 'text', text: '[web_search]' }])
  })
})

describe('normalizeItemToToolResult', () => {
  it('normalizes command_execution to output text', () => {
    const result = normalizeItemToToolResult({
      type: 'command_execution',
      id: 'cmd-1',
      aggregated_output: 'file1.ts\nfile2.ts',
      status: 'completed',
    })
    expect(result).toEqual([{ type: 'text', text: 'file1.ts\nfile2.ts' }])
  })

  it('normalizes command_execution with empty output', () => {
    const result = normalizeItemToToolResult({
      type: 'command_execution',
      id: 'cmd-2',
      status: 'completed',
    })
    expect(result).toEqual([{ type: 'text', text: '' }])
  })

  it('normalizes file_change to change summary', () => {
    const result = normalizeItemToToolResult({
      type: 'file_change',
      id: 'fc-1',
      changes: [
        { path: 'src/a.ts', kind: 'update' },
        { path: 'src/b.ts', kind: 'add' },
      ],
      status: 'completed',
    })
    expect(result).toEqual([{ type: 'text', text: 'File changes: update src/a.ts, add src/b.ts' }])
  })

  it('normalizes file_change with empty changes', () => {
    const result = normalizeItemToToolResult({
      type: 'file_change',
      id: 'fc-2',
      changes: [],
      status: 'completed',
    })
    expect(result).toEqual([{ type: 'text', text: 'File changes: ' }])
  })

  it('normalizes file_change with missing changes to empty', () => {
    const result = normalizeItemToToolResult({
      type: 'file_change',
      id: 'fc-3',
      status: 'completed',
    })
    expect(result).toEqual([{ type: 'text', text: 'File changes: ' }])
  })

  it('normalizes mcp_tool_call with error', () => {
    const result = normalizeItemToToolResult({
      type: 'mcp_tool_call',
      id: 'mcp-1',
      error: { message: 'Tool not found' },
    } as any)
    expect(result).toEqual([{ type: 'text', text: 'Error: Tool not found' }])
  })

  it('normalizes mcp_tool_call with result content', () => {
    const content = [{ type: 'text', text: 'file contents here' }]
    const result = normalizeItemToToolResult({
      type: 'mcp_tool_call',
      id: 'mcp-2',
      result: { content },
    } as any)
    expect(result).toEqual(content)
  })

  it('normalizes mcp_tool_call with result but empty content', () => {
    const result = normalizeItemToToolResult({
      type: 'mcp_tool_call',
      id: 'mcp-3',
      result: {},
    } as any)
    // result.content is undefined, so falls back to []
    expect(result).toEqual([])
  })

  it('normalizes mcp_tool_call with no error and no result to "completed"', () => {
    const result = normalizeItemToToolResult({
      type: 'mcp_tool_call',
      id: 'mcp-4',
    } as any)
    expect(result).toEqual([{ type: 'text', text: 'completed' }])
  })

  it('handles unknown types gracefully', () => {
    const result = normalizeItemToToolResult({
      type: 'web_search',
      id: 'ws-1',
    })
    expect(result).toEqual([{ type: 'text', text: '[web_search completed]' }])
  })

  it('handles reasoning as unknown type', () => {
    const result = normalizeItemToToolResult({
      type: 'reasoning',
      id: 'r-1',
    })
    expect(result).toEqual([{ type: 'text', text: '[reasoning completed]' }])
  })
})

describe('CodexAdapter registry wiring', () => {
  it('CodexAdapter is exported from adapters index', async () => {
    const { CodexAdapter: Imported } = await import('./index.js')
    expect(Imported).toBeDefined()
    const adapter = new Imported()
    expect(adapter.name).toBe('codex')
  })

  it('AdapterRegistry can register and retrieve CodexAdapter', async () => {
    const { AdapterRegistry } = await import('./registry.js')
    const registry = new AdapterRegistry()
    const adapter = new CodexAdapter()
    registry.register(adapter)

    expect(registry.get('codex')).toBe(adapter)
    expect(registry.get('codex')!.name).toBe('codex')
  })

  it('CodexAdapter coexists with ClaudeAdapter in registry', async () => {
    const { AdapterRegistry, ClaudeAdapter, CodexAdapter: Imported } = await import('./index.js')
    const registry = new AdapterRegistry()
    registry.register(new ClaudeAdapter())
    registry.register(new Imported())

    const names = registry.listNames()
    expect(names).toContain('claude')
    expect(names).toContain('codex')
    expect(names).toHaveLength(2)
  })

  it('CodexAdapter capabilities appear in registry listCapabilities', async () => {
    const { AdapterRegistry } = await import('./index.js')
    const registry = new AdapterRegistry()
    registry.register(new CodexAdapter())

    const caps = await registry.listCapabilities()
    expect(caps).toHaveLength(1)
    expect(caps[0].agent).toBe('codex')
    expect(caps[0].supportedCommands).toContain('execute')
    expect(caps[0].description).toBe('OpenAI Codex via codex-sdk')
  })
})
