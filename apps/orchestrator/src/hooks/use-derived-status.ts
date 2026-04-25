/**
 * useDerivedStatus — derive the current session status purely from the
 * messages collection, without relying on D1-mirrored state or TTL-based
 * staleness checks.
 *
 * Companion to `useDerivedGate`: while that hook extracts the active
 * gate payload, this hook collapses messages into a single
 * `SessionStatus` value (`'idle' | 'running' | 'waiting_gate'`).
 *
 * Scans messages tail-first (newest → oldest) so the first terminal or
 * in-flight marker encountered is the authoritative status. Returns
 * `undefined` when the collection is empty or no recognisable marker is
 * found (e.g. session just created, no turns yet).
 *
 * GH#76 P5 tiebreaker (revised): live-evidence signals (`running`,
 * `waiting_gate`, `pending`) always win over the D1 seq comparison —
 * they indicate active streaming / gating that can't be stale. Only
 * `idle` / `undefined` fall through to `session?.status` when D1 has
 * caught up (serverSeq >= localMaxSeq). This prevents two stale-status
 * edge cases:
 *   B1 — status-broadcast race: D1 flips to `idle` (via
 *        broadcastSessionRow through UserSettingsDO) before the final
 *        messages delta arrives on the session WS, causing the tiebreaker
 *        to suppress a valid `running` fold.
 *   B2 — new-turn seq gap: user sends turn N+1, D1 `messageSeq` bumps
 *        optimistically before `text@streaming` for N+1 lands locally;
 *        tiebreaker triggers, falls through to D1 `idle`.
 */

import { useMemo } from 'react'
import type { SessionMessagePart, SessionStatus } from '~/lib/types'
import { isPendingGatePart } from './use-derived-gate'
import { useMessagesCollection } from './use-messages-collection'
import { useSession } from './use-sessions-collection'

export function useDerivedStatus(sessionId: string | null): SessionStatus | undefined {
  const { messages } = useMessagesCollection(sessionId ?? '')
  const session = useSession(sessionId)

  return useMemo(() => {
    if (!messages || messages.length === 0) return undefined

    // Scan messages tail-first — first terminal or in-flight marker wins.
    let derived: SessionStatus | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      for (const part of (msg.parts as SessionMessagePart[] | undefined) ?? []) {
        if (part.type === 'awaiting_response' && (part as { state?: string }).state === 'pending') {
          derived = 'pending'
          break
        }

        if (part.type === 'result') {
          derived = 'idle'
          break
        }

        // Share the gate predicate with `useDerivedGate` so the two hooks
        // can't drift. Covers `tool-permission + approval-requested`,
        // `tool-ask_user + approval-requested`, AND `tool-AskUserQuestion +
        // input-available` (the SDK-native shape) — the last of which the
        // hand-rolled predicate here used to miss, leaving status to fall
        // through to stale D1 `running` while the runner was actually
        // parked on an AskUserQuestion gate.
        if (isPendingGatePart(part)) {
          derived = 'waiting_gate'
          break
        }

        const state = (part as { state?: string }).state
        if ((part.type === 'text' || part.type === 'reasoning') && state === 'streaming') {
          derived = 'running'
          break
        }

        // Mid-turn tool-execution wedge — assistant has emitted a tool_use
        // and the SDK is blocked on tool_result. Part shape:
        // `{ type: 'tool-<name>', state: 'input-available' }`. Without this
        // rule the tail-scan finds no marker on the in-flight assistant
        // turn, walks back to a prior `result` part, and returns 'idle'
        // while the runner is actively executing a tool. Originally fixed
        // in ad5f548; regressed by 362ca50's predicate-narrowing rewrite.
        if (
          typeof part.type === 'string' &&
          part.type.startsWith('tool-') &&
          state === 'input-available'
        ) {
          derived = 'running'
          break
        }
      }
      if (derived !== undefined) break
    }

    // Live-evidence signals are direct proof of current state — trust them
    // unconditionally regardless of D1 seq comparison.
    if (derived === 'running' || derived === 'waiting_gate' || derived === 'pending') {
      return derived
    }

    // For `idle` / `undefined` — apply the tiebreaker: if D1 has caught up
    // (or leads), return undefined so callers fall through to session?.status.
    // This prevents stale local `idle` from overriding a fresher D1 status
    // after reconnect.
    let localMaxSeq = -1
    for (const msg of messages) {
      const seq = (msg as { seq?: number }).seq ?? -1
      if (seq > localMaxSeq) localMaxSeq = seq
    }
    const serverSeq = (session?.messageSeq ?? -1) as number
    if (serverSeq >= localMaxSeq) return undefined

    return derived
  }, [messages, session])
}
