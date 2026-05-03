/**
 * @vitest-environment jsdom
 *
 * GH#152 P1.3 WU-E — TeamChatPanel component tests.
 *
 * Mocks `~/features/arc-orch/use-arc-chat` so the collection / WS /
 * TanStack DB layer never has to spin up in jsdom. The mocks expose
 * mutable getters so each test sets the per-render scenario and the
 * same imported `TeamChatPanel` reads it back. Mirrors the shape of
 * `features/agent-orch/CommentThread.test.tsx`.
 */

import type { ChatMessageRow } from '@duraclaw/shared-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '~/test-utils'

// ── Shared mock state, mutated per-test before render ─────────────────

const mockState: {
  messages: ChatMessageRow[]
  currentUserId: string | null
  sendChat: ReturnType<typeof vi.fn>
  editChat: ReturnType<typeof vi.fn>
  deleteChat: ReturnType<typeof vi.fn>
} = {
  messages: [],
  currentUserId: null,
  sendChat: vi.fn(),
  editChat: vi.fn(),
  deleteChat: vi.fn(),
}

vi.mock('~/features/arc-orch/use-arc-chat', () => ({
  useArcChat: () => mockState.messages,
  useArcChatActions: () => ({
    sendChat: mockState.sendChat,
    editChat: mockState.editChat,
    deleteChat: mockState.deleteChat,
    currentUserId: mockState.currentUserId,
  }),
}))

// GH#152 P1.6: TeamChatPanel composer now binds to the arc's chat-draft
// Y.Text via `useArcCollab`. Stub it here so the jsdom test harness
// doesn't have to spin up y-partyserver / WebSockets. The returned
// object reference is stable across renders so the composer's
// `useEffect([chatDraft])` doesn't re-fire on every parent re-render
// (which would clobber local textarea state via the observer).
const stubChatDraft = {
  toString: () => '',
  length: 0,
  doc: null as null,
  delete: vi.fn(),
  insert: vi.fn(),
  observe: vi.fn(),
  unobserve: vi.fn(),
}
const stubArcCollab = {
  chatDraft: stubChatDraft,
  notifyTyping: vi.fn(),
  provider: null,
  status: 'connecting' as const,
}
vi.mock('~/hooks/use-arc-collab', () => ({
  useArcCollab: () => stubArcCollab,
}))

// The presence bar is exercised in its own test file; here we only
// care about the chat-panel structure, so stub the bar to avoid pulling
// useArcPresence + the session-collab hook into this jsdom run.
vi.mock('~/components/arc-presence-bar', () => ({
  ArcPresenceBar: () => null,
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { TeamChatPanel } from './TeamChatPanel'

const ME = 'user-me'
const OTHER = 'user-other'

function chat(overrides: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    id: 'chat-1',
    arcId: 'arc-1',
    authorUserId: ME,
    body: 'hello',
    mentions: null,
    createdAt: 1000,
    modifiedAt: 1000,
    editedAt: null,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  }
}

function renderPanel() {
  return render(<TeamChatPanel arcId="arc-1" />)
}

beforeEach(() => {
  mockState.messages = []
  mockState.currentUserId = ME
  mockState.sendChat = vi.fn().mockResolvedValue({ ok: true })
  mockState.editChat = vi.fn().mockResolvedValue({ ok: true })
  mockState.deleteChat = vi.fn().mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

describe('TeamChatPanel — empty state + header', () => {
  it("renders the empty-state hint, header title, and 'Agent doesn't see this' caption", () => {
    renderPanel()
    expect(screen.getByText('No messages yet')).toBeTruthy()
    expect(screen.getByText('Team chat')).toBeTruthy()
    // The component uses a typographic apostrophe in "doesn't".
    expect(screen.getByText(/Agent doesn.t see this/)).toBeTruthy()
    // Composer textarea present + enabled.
    const textarea = screen.getByPlaceholderText('Message your team…') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
  })
})

describe('TeamChatPanel — render shape', () => {
  it('renders messages in the order received from useArcChat (hook owns sort)', () => {
    mockState.messages = [
      chat({ id: 'a', body: 'first', createdAt: 1000 }),
      chat({ id: 'b', body: 'second', createdAt: 2000 }),
      chat({ id: 'c', body: 'third', createdAt: 3000 }),
    ]
    renderPanel()
    const rows = document.querySelectorAll('[data-chat-id]')
    expect(rows).toHaveLength(3)
    expect(rows[0].getAttribute('data-chat-id')).toBe('a')
    expect(rows[1].getAttribute('data-chat-id')).toBe('b')
    expect(rows[2].getAttribute('data-chat-id')).toBe('c')
    expect(within(rows[0] as HTMLElement).getByText('first')).toBeTruthy()
    expect(within(rows[2] as HTMLElement).getByText('third')).toBeTruthy()
  })

  it('renders the (edited) marker when editedAt is set and not deleted', () => {
    mockState.messages = [chat({ editedAt: 2000, modifiedAt: 2000 })]
    renderPanel()
    expect(screen.getByText('(edited)')).toBeTruthy()
  })

  it('renders the deleted tombstone (and hides the body) when deletedAt is set', () => {
    mockState.messages = [
      chat({
        body: 'this should NOT show',
        deletedAt: 3000,
        deletedBy: OTHER,
        modifiedAt: 3000,
      }),
    ]
    renderPanel()
    expect(screen.queryByText('this should NOT show')).toBeNull()
    expect(screen.getByText(/deleted by user-other/i)).toBeTruthy()
  })

  it('shows author label + a relative-time string on each row', () => {
    // A message ~5 minutes old → "5m" branch in relativeTime.
    const fiveMinAgo = Date.now() - 5 * 60_000
    mockState.messages = [chat({ id: 'r1', authorUserId: OTHER, createdAt: fiveMinAgo })]
    renderPanel()
    const row = document.querySelector('[data-chat-id="r1"]') as HTMLElement
    expect(within(row).getByText(OTHER)).toBeTruthy()
    expect(within(row).getByText(/^\d+m$/)).toBeTruthy()
  })
})

describe('TeamChatPanel — author affordances', () => {
  it("shows Edit + Delete only on the current user's own non-deleted messages", () => {
    mockState.messages = [
      chat({ id: 'mine', authorUserId: ME, body: 'mine' }),
      chat({ id: 'theirs', authorUserId: OTHER, body: 'theirs' }),
    ]
    renderPanel()
    const mineEl = document.querySelector('[data-chat-id="mine"]') as HTMLElement
    const theirsEl = document.querySelector('[data-chat-id="theirs"]') as HTMLElement
    expect(within(mineEl).queryByText('Edit')).toBeTruthy()
    expect(within(mineEl).queryByText('Delete')).toBeTruthy()
    expect(within(theirsEl).queryByText('Edit')).toBeNull()
    expect(within(theirsEl).queryByText('Delete')).toBeNull()
  })

  it('hides Edit/Delete on a deleted message even if it was authored by me', () => {
    mockState.messages = [
      chat({
        id: 'mine-del',
        authorUserId: ME,
        deletedAt: 5000,
        deletedBy: ME,
        modifiedAt: 5000,
      }),
    ]
    renderPanel()
    const el = document.querySelector('[data-chat-id="mine-del"]') as HTMLElement
    expect(within(el).queryByText('Edit')).toBeNull()
    expect(within(el).queryByText('Delete')).toBeNull()
  })
})

describe('TeamChatPanel — composer actions', () => {
  it('Send calls sendChat({body}) with the textarea contents', async () => {
    renderPanel()
    const textarea = screen.getByPlaceholderText('Message your team…') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'a chat message' } })

    const sendBtn = screen.getByText('Send')
    await act(async () => {
      fireEvent.click(sendBtn)
    })

    expect(mockState.sendChat).toHaveBeenCalledTimes(1)
    expect(mockState.sendChat).toHaveBeenCalledWith({ body: 'a chat message' })
  })

  it('Edit save calls editChat({chatId, body})', async () => {
    mockState.messages = [chat({ id: 'chat-edit', body: 'original', authorUserId: ME })]
    renderPanel()

    await act(async () => {
      fireEvent.click(screen.getByText('Edit'))
    })

    // The inline edit textarea has the original body as value.
    const textareas = document.querySelectorAll('textarea')
    const editTextarea = Array.from(textareas).find(
      (t) => (t as HTMLTextAreaElement).value === 'original',
    ) as HTMLTextAreaElement
    expect(editTextarea).toBeTruthy()
    fireEvent.change(editTextarea, { target: { value: 'updated' } })

    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })

    expect(mockState.editChat).toHaveBeenCalledTimes(1)
    expect(mockState.editChat).toHaveBeenCalledWith({
      chatId: 'chat-edit',
      body: 'updated',
    })
  })

  it('Delete click calls deleteChat({chatId})', async () => {
    mockState.messages = [chat({ id: 'chat-del', authorUserId: ME })]
    renderPanel()

    await act(async () => {
      fireEvent.click(screen.getByText('Delete'))
    })

    expect(mockState.deleteChat).toHaveBeenCalledTimes(1)
    expect(mockState.deleteChat).toHaveBeenCalledWith({ chatId: 'chat-del' })
  })
})

describe('TeamChatPanel — auth gating', () => {
  it('composer is disabled with sign-in placeholder when currentUserId === null', () => {
    mockState.currentUserId = null
    renderPanel()
    const textarea = screen.getByPlaceholderText(
      'Sign in to chat with your team…',
    ) as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    const sendBtn = screen.getByText('Send') as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)
  })
})
