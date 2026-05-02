import type { SessionMessage } from 'agents/experimental/memory/session'
import { describe, expect, it } from 'vitest'

/**
 * GH#152 P1.2 WU-E — fork-semantics check for B10.
 *
 * Behavior under test: when an arc is branched (`branchArcImpl` →
 * `serializeHistoryForFork`), the new arc starts with zero comments
 * because comments live in the source DO's `comments` table and are
 * NOT part of the serialized history. Comment ids / bodies must never
 * appear in the wrapped prompt the SDK sees in the new arc.
 */

import { serializeHistoryForFork } from './branches'
import type { SessionDOContext } from './types'

interface FakeCommentRow {
  id: string
  body: string
  message_id: string
  parent_comment_id: string | null
}

/**
 * Minimal `ctx.session` stub — `serializeHistoryForFork` only calls
 * `getHistory()`. The rest of the Session surface (getMessage, branches,
 * etc.) is not touched on this path, so we don't bother stubbing it.
 */
function makeCtx(history: SessionMessage[], comments: FakeCommentRow[]): SessionDOContext {
  // The comments table sits behind ctx.sql; serializeHistoryForFork
  // never reads it. We expose a sql.exec that throws if called, so any
  // future regression that starts pulling comments into the fork would
  // fail loudly here.
  const sql = {
    exec: () => {
      throw new Error(
        'serializeHistoryForFork must NOT touch ctx.sql — comments must be excluded from forks',
      )
    },
  }

  return {
    do: { name: 'sess-parent', sql },
    session: {
      getHistory: () => history,
    },
    sql: sql as unknown as SqlStorage,
    // Plumbing for surface compatibility — none of these are accessed on
    // the serializeHistoryForFork path. We hand them through `comments`
    // for convenience so a debug print could inspect them.
    _testComments: comments,
  } as unknown as SessionDOContext
}

const userMsg = (id: string, text: string): SessionMessage =>
  ({
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
    createdAt: new Date(0),
  }) as unknown as SessionMessage

const assistantMsg = (id: string, text: string): SessionMessage =>
  ({
    id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    createdAt: new Date(0),
  }) as unknown as SessionMessage

describe('serializeHistoryForFork — comments stay in the source DO (B10)', () => {
  it('serializes message history without referencing comments', () => {
    const history = [
      userMsg('usr-1', 'help me refactor'),
      assistantMsg('msg-asst-1', 'Sure, here is the plan'),
    ]
    // Two comments anchored to the parent's transcript message — these
    // would only matter if the serializer pulled them in (it must not).
    const comments: FakeCommentRow[] = [
      {
        id: 'cmt-secret-parent',
        body: 'TOP_SECRET_COMMENT_BODY_PARENT',
        message_id: 'msg-asst-1',
        parent_comment_id: null,
      },
      {
        id: 'cmt-secret-reply',
        body: 'TOP_SECRET_COMMENT_BODY_REPLY',
        message_id: 'msg-asst-1',
        parent_comment_id: 'cmt-secret-parent',
      },
    ]
    const ctx = makeCtx(history, comments)
    const out = serializeHistoryForFork(ctx)

    // Sanity: the message history IS in the output.
    expect(out).toContain('help me refactor')
    expect(out).toContain('Sure, here is the plan')

    // The whole point: comment ids / bodies are NOT in the output.
    expect(out).not.toContain('cmt-secret-parent')
    expect(out).not.toContain('cmt-secret-reply')
    expect(out).not.toContain('TOP_SECRET_COMMENT_BODY_PARENT')
    expect(out).not.toContain('TOP_SECRET_COMMENT_BODY_REPLY')
  })

  it('returns an empty string when history is empty (no comment leakage from underlying tables)', () => {
    const ctx = makeCtx(
      [],
      [
        {
          id: 'cmt-orphan',
          body: 'ORPHAN_COMMENT_BODY',
          message_id: 'msg-deleted',
          parent_comment_id: null,
        },
      ],
    )
    const out = serializeHistoryForFork(ctx)
    expect(out).toBe('')
    expect(out).not.toContain('cmt-orphan')
    expect(out).not.toContain('ORPHAN_COMMENT_BODY')
  })

  it('respects the maxSeq cap and still excludes comments', () => {
    const history = [
      userMsg('usr-1', 'first turn'),
      assistantMsg('msg-asst-1', 'first reply'),
      userMsg('usr-2', 'second turn'),
      assistantMsg('msg-asst-2', 'second reply'),
    ]
    const comments: FakeCommentRow[] = [
      {
        id: 'cmt-1',
        body: 'COMMENT_ON_FIRST_REPLY',
        message_id: 'msg-asst-1',
        parent_comment_id: null,
      },
    ]
    const ctx = makeCtx(history, comments)
    const out = serializeHistoryForFork(ctx, 2)

    expect(out).toContain('first turn')
    expect(out).toContain('first reply')
    expect(out).not.toContain('second turn')
    expect(out).not.toContain('second reply')
    expect(out).not.toContain('COMMENT_ON_FIRST_REPLY')
  })
})
