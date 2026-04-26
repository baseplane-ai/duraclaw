import type { SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import type { SessionMessage } from 'agents/experimental/memory/session'
import type { GateResponse, StructuredAnswer } from '~/lib/types'
import { broadcastMessages as broadcastMessagesImpl } from './broadcast'
import { findPendingGatePartByHistory } from './gates'
import { sendToGateway } from './runner-link'
import type { SessionDOContext } from './types'

/**
 * Spec #101 Stage 6: extracted body of `SessionDO.resolveGate(...)`.
 * Pure delegation — gate-id lookup, gateway-command dispatch, part-state
 * flip + broadcast. No behavior change vs the in-class predecessor.
 */

/** Flatten a StructuredAnswer[] into a single semicolon-joined string for
 * the SDK's AskUserQuestion serialised-result contract. */
export function flattenStructuredAnswers(answers: StructuredAnswer[]): string {
  const parts: string[] = []
  for (const a of answers) {
    const label = (a.label ?? '').trim()
    const note = (a.note ?? '').trim()
    if (label && note) parts.push(`${label} (note: ${note})`)
    else if (label) parts.push(label)
    else if (note) parts.push(note)
  }
  return parts.join('; ')
}

export async function resolveGateImpl(
  ctx: SessionDOContext,
  gateId: string,
  response: GateResponse,
): Promise<{ ok: boolean; error?: string }> {
  const resolveStartedAt = Date.now()
  const responseShape = {
    hasAnswer: response.answer !== undefined,
    hasAnswers: response.answers !== undefined,
    answersCount: Array.isArray(response.answers) ? response.answers.length : null,
    hasApproved: response.approved !== undefined,
    approved: response.approved ?? null,
    declined: response.declined ?? null,
  }
  ctx.logEvent('info', 'gate', `resolveGate entered gateId=${gateId}`, {
    doId: ctx.ctx.id.toString(),
    sessionId: ctx.state.session_id ?? '?',
    gateId,
    ...responseShape,
  })

  // Relaxed: accept resolveGate in any status. The CLI terminal may have
  // already resolved the tool (advancing status to 'running'), but the web
  // UI still has the GateResolver mounted. Rejecting here just blocks the
  // user with a confusing error. The gate-id lookup below is the real guard.
  const match = findPendingGatePartByHistory(ctx.session.getHistory(), gateId)
  if (!match) {
    ctx.logEvent(
      'warn',
      'gate',
      `resolveGate not_found gateId=${gateId} duration_ms=${Date.now() - resolveStartedAt}`,
      {
        gateId,
        sessionId: ctx.state.session_id ?? '?',
        durationMs: Date.now() - resolveStartedAt,
      },
    )
    return {
      ok: false,
      error: `Gate '${gateId}' not found (no pending part in history)`,
    }
  }
  const gate: { id: string; type: 'ask_user' | 'permission_request' } = {
    id: gateId,
    type: match.type,
  }
  ctx.logEvent('info', 'gate', `resolveGate match found gateId=${gateId} type=${match.type}`, {
    gateId,
    type: match.type,
    sessionId: ctx.state.session_id ?? '?',
  })

  if (gate.type === 'permission_request' && response.approved !== undefined) {
    ctx.logEvent(
      'info',
      'gate',
      `resolveGate sending permission-response gateId=${gateId} allowed=${response.approved}`,
      {
        gateId,
        allowed: response.approved,
      },
    )
    sendToGateway(ctx, {
      type: 'permission-response',
      session_id: ctx.state.session_id ?? '',
      tool_call_id: gateId,
      allowed: response.approved,
    })
  } else if (gate.type === 'ask_user') {
    // Build a question-keyed answer record. The SDK's AskUserQuestion
    // tool serializes results as `User has answered your questions:
    // "<questionText>"="<answer>", ...` — so the key MUST be the full
    // question text (input.questions[i].question, not header).
    const partInput = (match.part as { input?: { questions?: unknown } }).input
    const rawQuestions = Array.isArray(partInput?.questions) ? partInput.questions : []
    const questions = rawQuestions as Array<{ question?: string; header?: string }>
    const declinedPlaceholder =
      '[User declined to answer. See subsequent message for next instruction.]'

    const buildPerQuestionValue = (i: number): string => {
      if (response.declined === true) return declinedPlaceholder
      if (response.answers !== undefined) {
        const a = response.answers[i]
        if (!a) return ''
        return flattenStructuredAnswers([a])
      }
      if (response.answer !== undefined) {
        // Legacy single-string path: apply to the first question only;
        // subsequent questions get empty strings.
        return i === 0 ? response.answer : ''
      }
      return ''
    }

    let answersRecord: Record<string, string>
    if (questions.length === 0) {
      // Legacy / SDK-native fallback: no `input.questions` array. Pick a
      // single key from anywhere reasonable on the part, falling back to
      // the literal 'question' so the answer string isn't lost.
      const partAny = match.part as { input?: { question?: string } }
      const fallbackKey =
        (typeof partAny.input?.question === 'string' && partAny.input.question.trim()) || 'question'
      let value: string
      if (response.declined === true) value = declinedPlaceholder
      else if (response.answers !== undefined) value = flattenStructuredAnswers(response.answers)
      else if (response.answer !== undefined) value = response.answer
      else {
        return { ok: false, error: 'Invalid response for gate type' }
      }
      console.warn(
        `[SessionDO:${ctx.ctx.id}] resolveGate: ask_user part missing input.questions, falling back to single-key '${fallbackKey}'`,
      )
      answersRecord = { [fallbackKey]: value }
    } else {
      // Validate that we have a usable response for at least one branch.
      if (
        response.declined !== true &&
        response.answers === undefined &&
        response.answer === undefined
      ) {
        return { ok: false, error: 'Invalid response for gate type' }
      }
      answersRecord = {}
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        const key =
          (typeof q?.question === 'string' && q.question.trim()) ||
          (typeof q?.header === 'string' && q.header.trim()) ||
          `question_${i}`
        answersRecord[key] = buildPerQuestionValue(i)
      }
    }

    const answerKeys = Object.keys(answersRecord)
    const answerKeySamples = answerKeys.map((k) => k.slice(0, 60))
    const answerLengths = answerKeys.map((k) => answersRecord[k]?.length ?? 0)
    const totalAnswerChars = answerLengths.reduce((acc, n) => acc + n, 0)
    ctx.logEvent(
      'info',
      'gate',
      `resolveGate sending answer gateId=${gateId} answers_keys=${answerKeys.length} total_chars=${totalAnswerChars}`,
      {
        gateId,
        answersKeys: answerKeys.length,
        totalChars: totalAnswerChars,
        keySamples: answerKeySamples,
        valueLengths: answerLengths,
      },
    )
    sendToGateway(ctx, {
      type: 'answer',
      session_id: ctx.state.session_id ?? '',
      tool_call_id: gateId,
      answers: answersRecord,
    })
  } else {
    ctx.logEvent(
      'warn',
      'gate',
      `resolveGate invalid_response gateId=${gateId} type=${gate.type}`,
      {
        gateId,
        type: gate.type,
        ...responseShape,
      },
    )
    return { ok: false, error: 'Invalid response for gate type' }
  }

  // Update the message part state for the resolved gate. Scan all messages
  // (newest-first) for the matching toolCallId rather than guessing the
  // message ID via currentTurnMessageId / turnCounter — the part may live
  // in any message after promoteToolPartToGate.
  const history = ctx.session.getHistory()
  let partUpdated = false
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    const partIdx = msg.parts.findIndex((p) => p.toolCallId === gateId)
    if (partIdx === -1) continue

    const updatedParts = msg.parts.map((p) => {
      if (p.toolCallId !== gateId) return p
      if (response.declined === true) {
        // ask_user dismissed by a follow-up user message — render as
        // "User declined to answer" via ResolvedAskUser's denied branch.
        return { ...p, state: 'output-denied', output: 'User declined to answer' }
      }
      if (response.approved !== undefined) {
        return {
          ...p,
          state: response.approved ? 'output-available' : 'output-denied',
          ...(response.approved && response.answer ? { output: response.answer } : {}),
        }
      }
      if (response.answers !== undefined) {
        return { ...p, state: 'output-available', output: { answers: response.answers } }
      }
      if (response.answer !== undefined) {
        return { ...p, state: 'output-available', output: response.answer }
      }
      return p
    })
    const updatedMsg: SessionMessage = { ...msg, parts: updatedParts }
    try {
      ctx.do.safeUpdateMessage(updatedMsg)
    } catch (err) {
      // updateMessage can fail if the message was garbage-collected,
      // created via the standalone fallback path, or the DO rehydrated
      // from hibernation with stale session state. Log but still
      // broadcast so the client UI clears the gate.
      console.error(`[SessionDO:${ctx.ctx.id}] resolveGate: updateMessage failed:`, err)
    }
    // Always broadcast even if updateMessage threw — the client needs the
    // part-state flip to clear its GateResolver.
    try {
      broadcastMessagesImpl(ctx, [updatedMsg as unknown as WireSessionMessage])
      partUpdated = true
    } catch (err) {
      console.error(`[SessionDO:${ctx.ctx.id}] resolveGate: broadcastMessage failed:`, err)
      return {
        ok: false,
        error: 'Gate answer sent to agent but failed to update UI — retry or reload',
      }
    }
    break
  }

  if (!partUpdated) {
    // The gateway command was already sent (answer delivered to runner),
    // but we couldn't find the message part to flip its state. Return an
    // error so the client can surface it.
    ctx.logEvent(
      'error',
      'gate',
      `resolveGate no_message_part gateId=${gateId} duration_ms=${Date.now() - resolveStartedAt} — answer sent but UI not updated`,
      {
        gateId,
        sessionId: ctx.state.session_id ?? '?',
        durationMs: Date.now() - resolveStartedAt,
      },
    )
    return {
      ok: false,
      error: 'Answer sent but gate UI may not clear — try reloading if it stays visible',
    }
  }

  ctx.logEvent(
    'info',
    'gate',
    `resolveGate ok gateId=${gateId} duration_ms=${Date.now() - resolveStartedAt}`,
    {
      gateId,
      sessionId: ctx.state.session_id ?? '?',
      durationMs: Date.now() - resolveStartedAt,
    },
  )
  ctx.do.updateState({ status: 'running' })
  // Mirror the status flip into D1 so `sessionsCollection.status` clears
  // promptly — useDerivedStatus yields to the D1 fallback for the
  // "Needs Attention" chip.
  return { ok: true }
}
