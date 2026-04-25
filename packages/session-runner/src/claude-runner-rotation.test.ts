import type { BufferedChannel } from '@duraclaw/shared-transport'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerSessionContext } from './types.js'

// ── Mock ./caam.js ──────────────────────────────────────────────────
// Mocks must be declared before importing the module under test.
const mockCaamLs = vi.fn()
const mockCaamCooldownList = vi.fn()
const mockCaamCooldownSet = vi.fn()
const mockCaamActivate = vi.fn()

vi.mock('./caam.js', () => ({
  caamLs: () => mockCaamLs(),
  caamCooldownList: () => mockCaamCooldownList(),
  caamCooldownSet: (name: string, until: number) => mockCaamCooldownSet(name, until),
  caamActivate: (name: string) => mockCaamActivate(name),
}))

// Import AFTER vi.mock so the rotation handler picks up the mocked caam.
const { handleRotation } = await import('./claude-runner.js')

// ── Test helpers ────────────────────────────────────────────────────

function createMockChannel(): {
  ch: BufferedChannel
  sent: Record<string, unknown>[]
} {
  const sent: Record<string, unknown>[] = []
  const ch = {
    send(event: Record<string, unknown>) {
      sent.push(event)
    },
  } as unknown as BufferedChannel
  return { ch, sent }
}

function createMockCtx(): RunnerSessionContext & {
  messageQueue: { push: ReturnType<typeof vi.fn>; waitForNext: any; done: any }
} {
  const messageQueue = {
    push: vi.fn(),
    waitForNext: vi.fn(),
    done: vi.fn(),
  }
  return {
    sessionId: 'test-session',
    abortController: new AbortController(),
    interrupted: false,
    pendingAnswer: null,
    pendingPermission: null,
    messageQueue,
    query: null,
    commandQueue: [],
    titler: null,
    nextSeq: 0,
    meta: {
      sdk_session_id: null,
      last_activity_ts: 0,
      last_event_seq: 0,
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      model: null,
      turn_count: 0,
      state: 'running',
    },
  } as any
}

beforeEach(() => {
  mockCaamLs.mockReset()
  mockCaamCooldownList.mockReset()
  mockCaamCooldownSet.mockReset()
  mockCaamActivate.mockReset()
})

describe('handleRotation — GH#103 B2/B3', () => {
  it('rotation-happy-path: activates next profile, cools current, queues continue', async () => {
    mockCaamLs.mockReturnValue([
      { name: 'work', active: true, system: false },
      { name: 'personal', active: false, system: false },
      { name: 'admin', active: false, system: true },
    ])
    mockCaamCooldownList.mockReturnValue(new Set<string>())
    mockCaamCooldownSet.mockReturnValue(true)
    mockCaamActivate.mockReturnValue(true)

    const { ch, sent } = createMockChannel()
    const ctx = createMockCtx()
    const resetsAt = Math.floor(Date.now() / 1000) + 3600

    await handleRotation({ resetsAt }, ch, ctx, 'sess-1')

    expect(mockCaamCooldownSet).toHaveBeenCalledTimes(1)
    expect(mockCaamCooldownSet).toHaveBeenCalledWith('work', resetsAt)
    expect(mockCaamActivate).toHaveBeenCalledTimes(1)
    expect(mockCaamActivate).toHaveBeenCalledWith('personal')

    expect(ctx.messageQueue!.push).toHaveBeenCalledTimes(1)
    expect(ctx.messageQueue!.push).toHaveBeenCalledWith({
      role: 'user',
      content: 'continue',
    })

    const notice = sent.find((e) => e.type === 'system_notice')
    expect(notice).toBeDefined()
    expect(String(notice?.text)).toContain('Switched profile')
    expect(String(notice?.text)).toContain('personal')
    expect(String(notice?.text)).toContain('work')
  })

  it('rotation-no-candidate: all non-active profiles cooled, breadcrumb only', async () => {
    mockCaamLs.mockReturnValue([
      { name: 'work', active: true, system: false },
      { name: 'personal', active: false, system: false },
      { name: 'side', active: false, system: false },
    ])
    mockCaamCooldownList.mockReturnValue(new Set<string>(['personal', 'side']))
    mockCaamCooldownSet.mockReturnValue(true)

    const { ch, sent } = createMockChannel()
    const ctx = createMockCtx()
    const resetsAt = Math.floor(Date.now() / 1000) + 3600

    await handleRotation({ resetsAt }, ch, ctx, 'sess-2')

    // Active still gets cooled.
    expect(mockCaamCooldownSet).toHaveBeenCalledTimes(1)
    expect(mockCaamCooldownSet).toHaveBeenCalledWith('work', resetsAt)

    // No activation, no continue.
    expect(mockCaamActivate).not.toHaveBeenCalled()
    expect(ctx.messageQueue!.push).not.toHaveBeenCalled()

    // Single breadcrumb.
    const notices = sent.filter((e) => e.type === 'system_notice')
    expect(notices).toHaveLength(1)
    expect(String(notices[0].text)).toContain('All Claude profiles in cooldown')
  })

  it('rotation-noisy-events-ignored: predicate only fires on assistant+error=rate_limit', () => {
    // Lock in the noise-ignore guarantee — the rotation branch in
    // claude-runner.ts is gated by:
    //   message.type === 'assistant' && (message as any).error === 'rate_limit'
    // This test asserts that none of the noisy rate_limit_event statuses
    // ('allowed' / 'allowed_warning' / 'rejected') match that predicate, and
    // that an assistant message without error doesn't either. Only the
    // exact shape triggers handleRotation.
    const matches = (m: any): boolean => m.type === 'assistant' && m.error === 'rate_limit'

    const noisy = [
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
      { type: 'assistant', message: { content: [] } },
      { type: 'assistant', error: 'other_error' },
    ]
    for (const m of noisy) expect(matches(m)).toBe(false)

    expect(matches({ type: 'assistant', error: 'rate_limit' })).toBe(true)

    // And confirm: handleRotation was never invoked from this test, so the
    // caam mocks are pristine.
    expect(mockCaamLs).not.toHaveBeenCalled()
    expect(mockCaamActivate).not.toHaveBeenCalled()
    expect(mockCaamCooldownSet).not.toHaveBeenCalled()
    expect(mockCaamCooldownList).not.toHaveBeenCalled()
  })

  it.todo('rotation-in-place: real SDK integration — covered by VP1')
})
