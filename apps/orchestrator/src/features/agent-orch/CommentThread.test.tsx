/**
 * @vitest-environment jsdom
 *
 * GH#152 P1.2 WU-E — CommentThread component tests.
 *
 * Mocks `~/features/agent-orch/use-comments-collection` so the
 * collection / WS / TanStack DB layer never has to spin up in jsdom.
 * Mocks `~/components/ui/sheet` (Radix Dialog wrapper) to plain divs to
 * sidestep portal + animate-presence quirks under jsdom.
 *
 * The mocks expose mutable getters so each test sets the per-render
 * scenario and the same imported `CommentThread` reads it back.
 */

import type { CommentRow } from '@duraclaw/shared-types'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Shared mock state, mutated per-test before render ─────────────────

interface CommentsForMessageReturn {
  comments: CommentRow[]
  replies: Map<string, CommentRow[]>
}

const mockState: {
  commentsForMessage: CommentsForMessageReturn
  currentUserId: string | null
  streamingMessageIds: Set<string>
  addComment: ReturnType<typeof vi.fn>
  editComment: ReturnType<typeof vi.fn>
  deleteComment: ReturnType<typeof vi.fn>
} = {
  commentsForMessage: { comments: [], replies: new Map() },
  currentUserId: null,
  streamingMessageIds: new Set(),
  addComment: vi.fn(),
  editComment: vi.fn(),
  deleteComment: vi.fn(),
}

vi.mock('~/features/agent-orch/use-comments-collection', () => ({
  useCommentsForMessage: () => mockState.commentsForMessage,
  useCommentActions: () => ({
    addComment: mockState.addComment,
    editComment: mockState.editComment,
    deleteComment: mockState.deleteComment,
    isMessageStreaming: (mid: string) => mockState.streamingMessageIds.has(mid),
    currentUserId: mockState.currentUserId,
  }),
}))

// Sonner is invoked from the component on error paths. Stub it so tests
// don't need a Toaster mounted.
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

// Replace the Radix Dialog-backed Sheet with bare divs. The component
// only relies on Sheet for layout + open/close semantics; we always
// pass `open={true}` in tests so a div passthrough is sufficient.
vi.mock('~/components/ui/sheet', () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="sheet">{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sheet-content">{children}</div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sheet-header">{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sheet-title">{children}</div>
  ),
  SheetDescription: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sheet-description">{children}</div>
  ),
}))

import { CommentThread } from './CommentThread'

const ME = 'user-me'
const OTHER = 'user-other'

function comment(overrides: Partial<CommentRow> = {}): CommentRow {
  return {
    id: 'cmt-1',
    arcId: 'arc-1',
    sessionId: 'sess-1',
    messageId: 'msg-1',
    parentCommentId: null,
    authorUserId: ME,
    body: 'hello',
    createdAt: 1000,
    modifiedAt: 1000,
    editedAt: null,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  }
}

function renderThread() {
  return render(
    <CommentThread sessionId="sess-1" messageId="msg-1" open={true} onOpenChange={vi.fn()} />,
  )
}

beforeEach(() => {
  mockState.commentsForMessage = { comments: [], replies: new Map() }
  mockState.currentUserId = ME
  mockState.streamingMessageIds = new Set()
  mockState.addComment = vi.fn().mockResolvedValue({ ok: true })
  mockState.editComment = vi.fn().mockResolvedValue({ ok: true })
  mockState.deleteComment = vi.fn().mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

describe('CommentThread — empty state', () => {
  it('renders the empty-state hint and an enabled top-level composer', () => {
    renderThread()
    expect(screen.getByText('No comments yet')).toBeTruthy()
    const textareas = screen.getAllByPlaceholderText('Add a comment…')
    expect(textareas).toHaveLength(1)
    expect((textareas[0] as HTMLTextAreaElement).disabled).toBe(false)
    expect(screen.getByText('Comments (0)')).toBeTruthy()
  })
})

describe('CommentThread — render shape', () => {
  it('renders parent comments + their indented one-level replies (B7)', () => {
    const parent = comment({ id: 'p1', body: 'parent body' })
    const reply = comment({
      id: 'r1',
      parentCommentId: 'p1',
      body: 'reply body',
      createdAt: 1500,
      modifiedAt: 1500,
    })
    mockState.commentsForMessage = {
      comments: [parent],
      replies: new Map([['p1', [reply]]]),
    }
    renderThread()

    const parentEl = document.querySelector('[data-comment-id="p1"]') as HTMLElement
    const replyEl = document.querySelector('[data-comment-id="r1"]') as HTMLElement
    expect(parentEl).toBeTruthy()
    expect(replyEl).toBeTruthy()
    expect(within(parentEl).getByText('parent body')).toBeTruthy()
    expect(within(replyEl).getByText('reply body')).toBeTruthy()

    // Reply carries the indent class (`ml-6` is applied for `isReply`).
    expect(replyEl.className).toContain('ml-')

    expect(screen.getByText('Comments (2)')).toBeTruthy()
  })

  it('renders the (edited) marker when editedAt is set and not deleted', () => {
    mockState.commentsForMessage = {
      comments: [comment({ editedAt: 2000, modifiedAt: 2000 })],
      replies: new Map(),
    }
    renderThread()
    expect(screen.getByText('(edited)')).toBeTruthy()
  })

  it('renders the deleted tombstone (and hides the body) when deletedAt is set', () => {
    mockState.commentsForMessage = {
      comments: [
        comment({
          body: 'this should NOT show',
          deletedAt: 3000,
          deletedBy: OTHER,
          modifiedAt: 3000,
        }),
      ],
      replies: new Map(),
    }
    renderThread()
    expect(screen.queryByText('this should NOT show')).toBeNull()
    // Tombstone surfaces "deleted by <user>".
    expect(screen.getByText(/deleted by user-other/i)).toBeTruthy()
  })
})

describe('CommentThread — author affordances', () => {
  it("shows Edit + Delete only on the current user's own non-deleted comments", () => {
    mockState.commentsForMessage = {
      comments: [
        comment({ id: 'mine', authorUserId: ME, body: 'mine' }),
        comment({ id: 'theirs', authorUserId: OTHER, body: 'theirs' }),
      ],
      replies: new Map(),
    }
    renderThread()

    const mineEl = document.querySelector('[data-comment-id="mine"]') as HTMLElement
    const theirsEl = document.querySelector('[data-comment-id="theirs"]') as HTMLElement

    expect(within(mineEl).queryByText('Edit')).toBeTruthy()
    expect(within(mineEl).queryByText('Delete')).toBeTruthy()
    expect(within(theirsEl).queryByText('Edit')).toBeNull()
    expect(within(theirsEl).queryByText('Delete')).toBeNull()
  })

  it('hides Edit/Delete on a deleted comment even if it was authored by me', () => {
    mockState.commentsForMessage = {
      comments: [
        comment({
          id: 'mine-del',
          authorUserId: ME,
          deletedAt: 5000,
          deletedBy: ME,
          modifiedAt: 5000,
        }),
      ],
      replies: new Map(),
    }
    renderThread()
    const el = document.querySelector('[data-comment-id="mine-del"]') as HTMLElement
    expect(within(el).queryByText('Edit')).toBeNull()
    expect(within(el).queryByText('Delete')).toBeNull()
  })
})

describe('CommentThread — lock-during-stream (B8)', () => {
  it('disables the composer textarea + shows the streaming helper note', () => {
    mockState.streamingMessageIds = new Set(['msg-1'])
    renderThread()

    const textarea = screen.getByPlaceholderText('Add a comment…') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(screen.getByText(/Message is streaming/i)).toBeTruthy()
  })
})

describe('CommentThread — composer actions', () => {
  it('Post on the top-level composer calls addComment with parentCommentId=null', async () => {
    renderThread()
    const textarea = screen.getByPlaceholderText('Add a comment…') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'a top-level comment' } })

    const postBtn = screen.getByText('Post')
    await act(async () => {
      fireEvent.click(postBtn)
    })

    expect(mockState.addComment).toHaveBeenCalledTimes(1)
    expect(mockState.addComment).toHaveBeenCalledWith({
      messageId: 'msg-1',
      body: 'a top-level comment',
      parentCommentId: null,
    })
  })

  it('Reply opens an inline composer; submitting it forwards parentCommentId', async () => {
    const parent = comment({ id: 'p-r', body: 'parent' })
    mockState.commentsForMessage = {
      comments: [parent],
      replies: new Map(),
    }
    renderThread()

    // Click Reply on the parent.
    await act(async () => {
      fireEvent.click(screen.getByText('Reply'))
    })

    // The reply composer surfaces with placeholder "Reply…".
    const replyTextarea = (await waitFor(() =>
      screen.getByPlaceholderText('Reply…'),
    )) as HTMLTextAreaElement
    fireEvent.change(replyTextarea, { target: { value: 'reply text' } })

    // Two Post buttons now (top-level + inline reply); the reply one is
    // adjacent to the reply textarea.
    const postButtons = screen.getAllByText('Post')
    expect(postButtons.length).toBeGreaterThanOrEqual(2)
    // The reply Post is in the reply textarea's parent form.
    const replyForm = replyTextarea.closest('form') as HTMLFormElement
    const replyPostBtn = within(replyForm).getByText('Post')

    await act(async () => {
      fireEvent.click(replyPostBtn)
    })

    expect(mockState.addComment).toHaveBeenCalledTimes(1)
    expect(mockState.addComment).toHaveBeenCalledWith({
      messageId: 'msg-1',
      body: 'reply text',
      parentCommentId: 'p-r',
    })
  })

  it('Edit save calls editComment({commentId, body})', async () => {
    mockState.commentsForMessage = {
      comments: [comment({ id: 'cmt-edit', body: 'original', authorUserId: ME })],
      replies: new Map(),
    }
    renderThread()

    await act(async () => {
      fireEvent.click(screen.getByText('Edit'))
    })

    // The inline edit textarea is the one with the original body as
    // value (the composer textarea is empty).
    const textareas = document.querySelectorAll('textarea')
    const editTextarea = Array.from(textareas).find(
      (t) => (t as HTMLTextAreaElement).value === 'original',
    ) as HTMLTextAreaElement
    expect(editTextarea).toBeTruthy()
    fireEvent.change(editTextarea, { target: { value: 'updated' } })

    await act(async () => {
      fireEvent.click(screen.getByText('Save'))
    })

    expect(mockState.editComment).toHaveBeenCalledTimes(1)
    expect(mockState.editComment).toHaveBeenCalledWith({
      commentId: 'cmt-edit',
      body: 'updated',
    })
  })

  it('Delete click calls deleteComment({commentId})', async () => {
    mockState.commentsForMessage = {
      comments: [comment({ id: 'cmt-del', authorUserId: ME })],
      replies: new Map(),
    }
    renderThread()

    await act(async () => {
      fireEvent.click(screen.getByText('Delete'))
    })

    expect(mockState.deleteComment).toHaveBeenCalledTimes(1)
    expect(mockState.deleteComment).toHaveBeenCalledWith({ commentId: 'cmt-del' })
  })
})
