import type { SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import type { SessionMessage, SessionMessagePart } from 'agents/experimental/memory/session'
import { broadcastMessages } from './broadcast'
import type { SessionDOContext } from './types'

export type PendingGateType = 'ask_user' | 'permission_request'

/**
 * Set of abstract gate-part kinds (spec #101 B5). Adding a new gate type
 * is a single-line edit here — the predicate consumers iterate this set.
 */
export const GATE_PART_TYPES = new Set<PendingGateType>(['ask_user', 'permission_request'])

/**
 * Predicate: is `p` a still-pending gate part?
 *
 * Three shapes count as pending:
 *   - `tool-ask_user` + `approval-requested` (DO-promoted ask_user)
 *   - `tool-permission` + `approval-requested` (canUseTool permission)
 *   - `tool-AskUserQuestion` + `input-available` (SDK-native shape, post
 *     `1f6678e` no longer promoted to `tool-ask_user`)
 *
 * Mirrors `isPendingGate` in `ChatThread.tsx` (client render predicate).
 * Used by `SessionDO.interrupt()` to flip every pending gate part to a
 * terminal state on Stop, so the client's GateResolver unmounts.
 */
export function isPendingGatePart(p: SessionMessagePart): boolean {
  if (
    p.state === 'approval-requested' &&
    (p.type === 'tool-ask_user' || p.type === 'tool-permission')
  ) {
    return true
  }
  if (p.state === 'input-available' && p.type === 'tool-AskUserQuestion') {
    return true
  }
  return false
}

/**
 * Walk message history newest-first looking for a still-pending gate part
 * whose `toolCallId` matches `gateId`. Pure helper variant taking a
 * history array — used by `SessionDO.resolveGate` directly and by the
 * ctx-bound wrapper below.
 *
 * Returns `null` when no part with that id exists, or the matching part
 * has already moved past `approval-requested` (output-available /
 * output-denied).
 */
export function findPendingGatePartByHistory(
  history: SessionMessage[],
  gateId: string,
): { type: PendingGateType; part: SessionMessagePart } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    for (const p of msg.parts) {
      if (p.toolCallId !== gateId) continue
      // `tool-AskUserQuestion` / `input-available` is the SDK-native
      // shape before `promoteToolPartToGate` flips it; the client now
      // renders the gate directly off this shape, so a resolve can
      // arrive before the promotion (or if the promotion was
      // silent-dropped on a half-closed socket). Match it too.
      if (
        p.type === 'tool-AskUserQuestion' &&
        (p.state === 'input-available' || p.state === 'approval-requested')
      ) {
        return { type: 'ask_user', part: p }
      }
      if (p.state !== 'approval-requested') continue
      if (p.type === 'tool-ask_user') return { type: 'ask_user', part: p }
      if (p.type === 'tool-permission') return { type: 'permission_request', part: p }
    }
  }
  return null
}

/**
 * Walk the live session history newest-first looking for a still-pending
 * gate part whose `toolCallId` matches `gateId`. Wraps the pure-history
 * variant so callers can pass a `SessionDOContext`.
 */
export function findPendingGatePart(
  ctx: SessionDOContext,
  gateId: string,
): { type: PendingGateType; part: SessionMessagePart } | null {
  return findPendingGatePartByHistory(ctx.session.getHistory(), gateId)
}

/**
 * Mark every pending gate part across all messages as `output-denied`
 * with `output: 'Interrupted'`. Used by `interrupt()` and any other Stop
 * path that needs to dismiss a stuck `GateResolver` modal.
 *
 * "Pending" mirrors `isPendingGatePart` (session-do-helpers.ts):
 *   - tool-ask_user / approval-requested
 *   - tool-permission / approval-requested
 *   - tool-AskUserQuestion / input-available  (SDK-native shape)
 */
export function clearPendingGateParts(ctx: SessionDOContext): void {
  const history = ctx.session.getHistory()
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    const hasPendingGate = msg.parts.some(isPendingGatePart)
    if (!hasPendingGate) continue
    const updatedParts = msg.parts.map((p) =>
      isPendingGatePart(p) ? { ...p, state: 'output-denied' as const, output: 'Interrupted' } : p,
    )
    const updatedMsg: SessionMessage = { ...msg, parts: updatedParts }
    try {
      ctx.do.safeUpdateMessage(updatedMsg)
      broadcastMessages(ctx, [updatedMsg as unknown as WireSessionMessage])
    } catch (err) {
      console.error(`[SessionDO:${ctx.ctx.id}] Failed to mark gate interrupted:`, err)
    }
  }
}

/**
 * Locate the `assistant` message part the SDK already wrote for `toolCallId`
 * and promote it to a gate part (`tool-ask_user` / `tool-permission`,
 * `state: approval-requested`). The promotion preserves any existing
 * `input` payload the SDK already populated.
 *
 * Race-safe: if the part is already in a terminal output state (resolveGate
 * ran first), returns `'already-resolved'` without regressing state. If no
 * matching part exists yet (assistant event not yet processed), creates a
 * standalone gate message as a fallback so the gate is never invisible.
 */
export function promoteToolPartToGate(
  ctx: SessionDOContext,
  toolCallId: string,
  newType: string,
  newToolName: string,
  input: Record<string, unknown>,
): 'promoted' | 'already-resolved' | 'no-part' {
  const history = ctx.session.getHistory()
  let promoted = false
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    const idx = msg.parts.findIndex((p) => p.toolCallId === toolCallId)
    if (idx === -1) continue

    // Race guard: with the SDK-native direct-render path, a fast user can
    // submit before this `ask_user` event reaches the DO. If the matching
    // part is already in a terminal output state (resolveGate ran first),
    // do NOT regress `state` back to `approval-requested` — that re-opens
    // the GateResolver in the UI and leaves it stuck. Return
    // 'already-resolved' so the caller skips its scalar-gate side
    // effects too.
    const existingState = msg.parts[idx].state
    if (
      existingState === 'output-available' ||
      existingState === 'output-error' ||
      existingState === 'output-denied' ||
      existingState === 'approval-given' ||
      existingState === 'approval-denied'
    ) {
      return 'already-resolved'
    }

    const updatedParts = [...msg.parts]
    updatedParts[idx] = {
      ...updatedParts[idx],
      type: newType,
      toolName: newToolName,
      input: updatedParts[idx].input ?? input, // keep SDK input if present
      state: 'approval-requested',
    }
    const updatedMsg: SessionMessage = { ...msg, parts: updatedParts }
    try {
      ctx.do.safeUpdateMessage(updatedMsg)
      broadcastMessages(ctx, [updatedMsg as unknown as WireSessionMessage])
    } catch (err) {
      console.error('[session-do] event persist failed', err)
    }
    promoted = true
    break
  }

  // Fallback: assistant event hasn't created the part yet — create a
  // standalone message so the gate is never invisible.
  if (!promoted) {
    console.warn(
      `[SessionDO:${ctx.ctx.id}] promoteToolPartToGate: no part with toolCallId '${toolCallId}' — creating standalone gate message`,
    )
    const gateMsg: SessionMessage = {
      id: `gate-${toolCallId}`,
      role: 'assistant',
      parts: [
        {
          type: newType,
          toolCallId,
          toolName: newToolName,
          input,
          state: 'approval-requested',
        },
      ],
      createdAt: new Date(),
    }
    try {
      void ctx.do.safeAppendMessage(gateMsg)
      broadcastMessages(ctx, [gateMsg as unknown as WireSessionMessage])
    } catch (err) {
      console.error(`[SessionDO:${ctx.ctx.id}] Failed to create standalone gate:`, err)
    }
    return 'no-part'
  }
  return 'promoted'
}
