import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionChannel } from '../session-channel.js'
import type { GatewaySessionContext } from '../types.js'
import { ClaudeAdapter, handleCanUseTool, isIdleStop } from './claude.js'

/** Create a mock SessionChannel that records sent messages. */
function createMockChannel(): { ch: SessionChannel; sent: string[]; parsedMessages: () => any[] } {
  const sent: string[] = []
  const ch: SessionChannel = {
    send(data: string) {
      sent.push(data)
    },
    close() {},
    readyState: 1,
  }
  return { ch, sent, parsedMessages: () => sent.map((s) => JSON.parse(s)) }
}

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
    it('sends error event via SessionChannel when project is not found', async () => {
      const adapter = new ClaudeAdapter()
      const { ch, parsedMessages } = createMockChannel()

      const ctx = createMockCtx()
      const cmd = {
        type: 'execute' as const,
        project: 'nonexistent-project-xyz-999',
        prompt: 'hello',
      }

      await adapter.execute(ch, cmd, ctx)

      const msgs = parsedMessages()
      expect(msgs.length).toBe(1)
      expect(msgs[0].type).toBe('error')
      expect(msgs[0].error).toContain('not found')
      expect(msgs[0].session_id).toBe('test-session')
    })
  })

  describe('resume with unknown project', () => {
    it('sends error event via SessionChannel when project is not found', async () => {
      const adapter = new ClaudeAdapter()
      const { ch, parsedMessages } = createMockChannel()

      const ctx = createMockCtx()
      const cmd = {
        type: 'resume' as const,
        project: 'nonexistent-project-xyz-999',
        prompt: 'continue',
        sdk_session_id: 'fake-session-id',
      }

      await adapter.resume(ch, cmd, ctx)

      const msgs = parsedMessages()
      expect(msgs.length).toBe(1)
      expect(msgs[0].type).toBe('error')
      expect(msgs[0].error).toContain('not found')
    })
  })

  describe('SessionChannel integration', () => {
    it('execute accepts a SessionChannel and sends JSON via ch.send()', async () => {
      const adapter = new ClaudeAdapter()
      const sendSpy = vi.fn()
      const ch: SessionChannel = {
        send: sendSpy,
        close() {},
        readyState: 1,
      }

      const ctx = createMockCtx()
      const cmd = {
        type: 'execute' as const,
        project: 'nonexistent-project-xyz-999',
        prompt: 'hello',
      }

      await adapter.execute(ch, cmd, ctx)

      expect(sendSpy).toHaveBeenCalledTimes(1)
      const parsed = JSON.parse(sendSpy.mock.calls[0][0])
      expect(parsed.type).toBe('error')
    })

    it('resume accepts a SessionChannel and sends JSON via ch.send()', async () => {
      const adapter = new ClaudeAdapter()
      const sendSpy = vi.fn()
      const ch: SessionChannel = {
        send: sendSpy,
        close() {},
        readyState: 1,
      }

      const ctx = createMockCtx()
      const cmd = {
        type: 'resume' as const,
        project: 'nonexistent-project-xyz-999',
        prompt: 'continue',
        sdk_session_id: 'fake-session-id',
      }

      await adapter.resume(ch, cmd, ctx)

      expect(sendSpy).toHaveBeenCalledTimes(1)
      const parsed = JSON.parse(sendSpy.mock.calls[0][0])
      expect(parsed.type).toBe('error')
    })

    it('swallows errors when SessionChannel.send() throws (closed channel)', async () => {
      const adapter = new ClaudeAdapter()
      const ch: SessionChannel = {
        send() {
          throw new Error('Channel closed')
        },
        close() {},
        readyState: 3, // CLOSED
      }

      const ctx = createMockCtx()
      const cmd = {
        type: 'execute' as const,
        project: 'nonexistent-project-xyz-999',
        prompt: 'hello',
      }

      // Should not throw even when ch.send() throws
      await expect(adapter.execute(ch, cmd, ctx)).resolves.toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// handleCanUseTool tests (TDD — function will be extracted in implementation)
// ---------------------------------------------------------------------------

function createMockSend() {
  const sent: Record<string, unknown>[] = []
  const sendEvent = (event: Record<string, unknown>) => {
    sent.push(event)
  }
  return { sendEvent, sent }
}

const sampleQuestions = [
  {
    question: 'Which?',
    header: 'Library',
    options: [{ label: 'lodash', description: 'Utility lib' }],
    multiSelect: false,
  },
]

describe('handleCanUseTool — AskUserQuestion', () => {
  it('sends ask_user event with questions array and toolUseID', async () => {
    const ctx = createMockCtx()
    const { sendEvent, sent } = createMockSend()

    const promise = handleCanUseTool(
      'AskUserQuestion',
      { questions: sampleQuestions },
      { signal: new AbortController().signal, toolUseID: 'tu-1' },
      ctx,
      sendEvent,
      'sess-1',
    )

    // Resolve the pendingAnswer that handleCanUseTool sets on ctx
    queueMicrotask(() => {
      ctx.pendingAnswer!.resolve({ answer: 'lodash' })
    })

    await promise

    expect(sent.length).toBeGreaterThanOrEqual(1)
    const msg = sent[0]
    expect(msg.type).toBe('ask_user')
    expect(msg.session_id).toBe('sess-1')
    expect(msg.tool_call_id).toBe('tu-1')
    expect(msg.questions).toEqual(sampleQuestions)
  })

  it('blocks until pendingAnswer is resolved, returns allow with updatedInput', async () => {
    const ctx = createMockCtx()
    const { sendEvent } = createMockSend()

    const promise = handleCanUseTool(
      'AskUserQuestion',
      { questions: sampleQuestions },
      { signal: new AbortController().signal, toolUseID: 'tu-2' },
      ctx,
      sendEvent,
      'sess-2',
    )

    // Resolve after a tick so the function is actually waiting
    queueMicrotask(() => {
      ctx.pendingAnswer!.resolve({ answer: 'lodash' })
    })

    const result = await promise

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: sampleQuestions,
        answers: { answer: 'lodash' },
      },
    })
  })

  describe('timeout and abort', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('does not time out — agent waits indefinitely for an answer', async () => {
      const ctx = createMockCtx()
      const { sendEvent } = createMockSend()

      const promise = handleCanUseTool(
        'AskUserQuestion',
        { questions: sampleQuestions },
        { signal: new AbortController().signal, toolUseID: 'tu-3' },
        ctx,
        sendEvent,
        'sess-3',
      )

      // Advance well past the old 5-minute timeout — should still be pending
      vi.advanceTimersByTime(60 * 60 * 1000)

      // Race against a microtask sentinel to confirm the promise is still pending
      const settled = await Promise.race([
        promise.then(
          () => 'resolved',
          () => 'rejected',
        ),
        Promise.resolve('pending'),
      ])
      expect(settled).toBe('pending')

      // Cleanly resolve so the test doesn't leak a pending promise
      ctx.pendingAnswer!.resolve({ answer: 'late' })
      await promise
    })

    it('rejects when abort signal fires', async () => {
      const ctx = createMockCtx()
      const { sendEvent } = createMockSend()
      const ac = new AbortController()

      const promise = handleCanUseTool(
        'AskUserQuestion',
        { questions: sampleQuestions },
        { signal: ac.signal, toolUseID: 'tu-4' },
        ctx,
        sendEvent,
        'sess-4',
      )

      ac.abort()

      await expect(promise).rejects.toThrow(/abort/i)
    })
  })
})

describe('handleCanUseTool — permission requests', () => {
  it('sends permission_request event with tool details', async () => {
    const ctx = createMockCtx()
    const { sendEvent, sent } = createMockSend()

    const promise = handleCanUseTool(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'tu-10' },
      ctx,
      sendEvent,
      'sess-10',
    )

    queueMicrotask(() => {
      ctx.pendingPermission!.resolve(true)
    })

    await promise

    expect(sent.length).toBeGreaterThanOrEqual(1)
    const msg = sent[0]
    expect(msg.type).toBe('permission_request')
    expect(msg.session_id).toBe('sess-10')
    expect(msg.tool_call_id).toBe('tu-10')
    expect(msg.tool_name).toBe('Bash')
    expect(msg.input).toEqual({ command: 'ls' })
  })

  it('returns allow when permission granted', async () => {
    const ctx = createMockCtx()
    const { sendEvent } = createMockSend()

    const promise = handleCanUseTool(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'tu-11' },
      ctx,
      sendEvent,
      'sess-11',
    )

    queueMicrotask(() => {
      ctx.pendingPermission!.resolve(true)
    })

    const result = await promise
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  // Regression guard: the SDK's runtime Zod validator requires `updatedInput`
  // on every `allow` result (the `.d.ts` lies — it marks it optional). If this
  // property is dropped, user-approved permission prompts will fail with a
  // ZodError, most visibly when writing to `.claude/*` paths.
  it('always includes updatedInput on allow (SDK Zod requirement)', async () => {
    const ctx = createMockCtx()
    const { sendEvent } = createMockSend()
    const input = { file_path: '/repo/.claude/settings.json', content: '{}' }

    const promise = handleCanUseTool(
      'Write',
      input,
      { signal: new AbortController().signal, toolUseID: 'tu-regress-1' },
      ctx,
      sendEvent,
      'sess-regress-1',
    )

    queueMicrotask(() => {
      ctx.pendingPermission!.resolve(true)
    })

    const result = await promise
    if (result.behavior !== 'allow') throw new Error('expected allow')
    expect(result.updatedInput).toBeDefined()
    expect(result.updatedInput).toEqual(input)
  })

  it('returns deny when permission denied', async () => {
    const ctx = createMockCtx()
    const { sendEvent } = createMockSend()

    const promise = handleCanUseTool(
      'Bash',
      { command: 'rm -rf /' },
      { signal: new AbortController().signal, toolUseID: 'tu-12' },
      ctx,
      sendEvent,
      'sess-12',
    )

    queueMicrotask(() => {
      ctx.pendingPermission!.resolve(false)
    })

    const result = await promise
    expect(result).toEqual({ behavior: 'deny', message: 'Denied by user' })
  })

  describe('timeout and abort', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('does not time out — agent waits indefinitely for a decision', async () => {
      const ctx = createMockCtx()
      const { sendEvent } = createMockSend()

      const promise = handleCanUseTool(
        'Bash',
        { command: 'ls' },
        { signal: new AbortController().signal, toolUseID: 'tu-13' },
        ctx,
        sendEvent,
        'sess-13',
      )

      vi.advanceTimersByTime(60 * 60 * 1000)

      const settled = await Promise.race([
        promise.then(
          () => 'resolved',
          () => 'rejected',
        ),
        Promise.resolve('pending'),
      ])
      expect(settled).toBe('pending')

      ctx.pendingPermission!.resolve(true)
      await promise
    })

    it('rejects when abort signal fires', async () => {
      const ctx = createMockCtx()
      const { sendEvent } = createMockSend()
      const ac = new AbortController()

      const promise = handleCanUseTool(
        'Bash',
        { command: 'ls' },
        { signal: ac.signal, toolUseID: 'tu-14' },
        ctx,
        sendEvent,
        'sess-14',
      )

      ac.abort()

      await expect(promise).rejects.toThrow(/abort/i)
    })
  })
})

describe('handleCanUseTool — round-trip integration', () => {
  it('AskUserQuestion: event emitted → answer resolved → returns updatedInput with answers merged', async () => {
    const ctx = createMockCtx()
    const { sendEvent, sent } = createMockSend()
    const questions = [
      {
        question: 'Which config format?',
        header: 'Config',
        options: [
          { label: 'YAML', description: 'Human-readable' },
          { label: 'TOML', description: 'Minimal format' },
          { label: 'JSON', description: 'JS notation' },
        ],
        multiSelect: false,
      },
    ]

    const promise = handleCanUseTool(
      'AskUserQuestion',
      { questions },
      { signal: new AbortController().signal, toolUseID: 'tu-rt-1' },
      ctx,
      sendEvent,
      'sess-rt-1',
    )

    // Verify event was sent immediately
    expect(sent.length).toBe(1)
    expect(sent[0]).toEqual({
      type: 'ask_user',
      session_id: 'sess-rt-1',
      tool_call_id: 'tu-rt-1',
      questions,
    })

    // Simulate orchestrator relaying user's answer
    queueMicrotask(() => {
      ctx.pendingAnswer!.resolve({ 'Which config format?': 'YAML' })
    })

    const result = await promise

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions,
        answers: { 'Which config format?': 'YAML' },
      },
    })
  })

  it('permission: grant then deny on sequential calls', async () => {
    const ctx = createMockCtx()
    const { sendEvent, sent } = createMockSend()

    // First call: grant
    const p1 = handleCanUseTool(
      'Write',
      { file_path: '/tmp/test.ts', content: 'hello' },
      { signal: new AbortController().signal, toolUseID: 'tu-rt-2' },
      ctx,
      sendEvent,
      'sess-rt-2',
    )
    queueMicrotask(() => ctx.pendingPermission!.resolve(true))
    expect(await p1).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/tmp/test.ts', content: 'hello' },
    })

    // Second call: deny
    const p2 = handleCanUseTool(
      'Bash',
      { command: 'rm -rf /' },
      { signal: new AbortController().signal, toolUseID: 'tu-rt-3' },
      ctx,
      sendEvent,
      'sess-rt-2',
    )
    queueMicrotask(() => ctx.pendingPermission!.resolve(false))
    expect(await p2).toEqual({ behavior: 'deny', message: 'Denied by user' })

    expect(sent.length).toBe(2)
    expect(sent[0].type).toBe('permission_request')
    expect(sent[0].tool_name).toBe('Write')
    expect(sent[1].type).toBe('permission_request')
    expect(sent[1].tool_name).toBe('Bash')
  })
})

// ---------------------------------------------------------------------------
// isIdleStop — detects "No response requested." SDK idle stops
// ---------------------------------------------------------------------------

describe('isIdleStop', () => {
  it('returns true for "No response requested."', () => {
    expect(isIdleStop({ subtype: 'success', result: 'No response requested.' })).toBe(true)
  })

  it('returns true case-insensitively', () => {
    expect(isIdleStop({ subtype: 'success', result: 'no response requested.' })).toBe(true)
    expect(isIdleStop({ subtype: 'success', result: 'NO RESPONSE REQUESTED.' })).toBe(true)
  })

  it('returns true without trailing period', () => {
    expect(isIdleStop({ subtype: 'success', result: 'No response requested' })).toBe(true)
  })

  it('returns true with leading/trailing whitespace', () => {
    expect(isIdleStop({ subtype: 'success', result: '  No response requested.  ' })).toBe(true)
  })

  it('returns false for error results', () => {
    expect(isIdleStop({ subtype: 'error', result: 'No response requested.' })).toBe(false)
  })

  it('returns false for real results', () => {
    expect(isIdleStop({ subtype: 'success', result: 'Task completed successfully' })).toBe(false)
  })

  it('returns false for empty/null results', () => {
    expect(isIdleStop({ subtype: 'success', result: '' })).toBe(false)
    expect(isIdleStop({ subtype: 'success', result: null })).toBe(false)
    expect(isIdleStop({ subtype: 'success' })).toBe(false)
  })

  it('returns false for partial matches', () => {
    expect(
      isIdleStop({ subtype: 'success', result: 'No response requested. Also did other work.' }),
    ).toBe(false)
  })
})
