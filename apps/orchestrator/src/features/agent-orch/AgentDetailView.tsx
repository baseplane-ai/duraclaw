/**
 * AgentDetailView — Live status display for a single SessionDO instance.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { StatusBar } from '~/components/status-bar'
import { agentSessionsCollection, type SessionRecord } from '~/db/agent-sessions-collection'
import { readSessionStatusCache, writeSessionStatusCache } from '~/db/session-status-collection'
import type { ProjectInfo, SessionState, SessionStatus } from '~/lib/types'
import { useStatusBarStore } from '~/stores/status-bar'
import { ChatThread } from './ChatThread'
import { ConversationDownload } from './ConversationDownload'
import { KataStatePanel } from './KataStatePanel'
import { MessageInput } from './MessageInput'
import type { UseCodingAgentResult } from './use-coding-agent'

interface AgentDetailViewProps {
  name: string
  agent: UseCodingAgentResult
}

/**
 * Synthesize a partial SessionState from the server-backed SessionRecord
 * so tabs the user has never opened still render an informative status bar
 * instead of flashing blank. Only basic fields (project, status, model,
 * num_turns, timestamps) — richer fields (gate, summary, error) come in
 * via the live WS as soon as it connects.
 */
function synthesizeStateFromSessionRecord(record: SessionRecord): SessionState {
  return {
    status: record.status as SessionStatus,
    session_id: record.id,
    project: record.project,
    project_path: '',
    model: record.model ?? null,
    prompt: record.prompt ?? '',
    userId: record.userId,
    started_at: record.lastActivity ?? record.createdAt,
    completed_at: null,
    num_turns: record.numTurns ?? 0,
    total_cost_usd: record.totalCostUsd ?? null,
    duration_ms: record.durationMs ?? null,
    gate: null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    result: null,
    error: null,
    summary: record.summary ?? null,
    sdk_session_id: record.sdkSessionId ?? null,
  }
}

export function AgentDetailView({ name: sessionId, agent }: AgentDetailViewProps) {
  const {
    state,
    messages,
    sessionResult,
    kataState,
    contextUsage,
    wsReadyState,
    isConnecting,
    stop,
    interrupt,
    resolveGate,
    sendMessage,
    submitDraft,
    rewind,
    injectQaPair,
    branchInfo,
    navigateBranch,
  } = agent

  // Sync session data to global status bar store
  const statusBarSet = useStatusBarStore((s) => s.set)
  const statusBarClear = useStatusBarStore((s) => s.clear)

  // Cache-first hydration — runs before first paint on tab switch so the
  // status bar renders immediately with persisted values instead of flashing
  // blank while waiting on WS state sync + getContextUsage RPC + projects
  // fetch. Live values from the hook overwrite cached values below once they
  // arrive. Safe to call synchronously: readSessionStatusCache is a sync
  // collection read and no-ops when OPFS is unavailable.
  useLayoutEffect(() => {
    const cached = readSessionStatusCache(sessionId)
    if (cached) {
      statusBarSet({
        state: cached.state,
        contextUsage: cached.contextUsage,
        kataState: cached.kataState,
        worktreeInfo: cached.worktreeInfo,
        sessionResult: cached.sessionResult,
      })
      return
    }
    // Fallback: synthesize from the server-backed agent_sessions list so
    // tabs the user has never opened (no session_status entry yet) still
    // render the project / status / model / turns immediately from the
    // already-loaded session record.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const record = (agentSessionsCollection as any).get?.(sessionId) as SessionRecord | undefined
      if (record) {
        statusBarSet({ state: synthesizeStateFromSessionRecord(record) })
      }
    } catch {
      // collection may not be ready
    }
  }, [sessionId, statusBarSet])

  // Write live values to the store. Guarded so a null live value (WS hasn't
  // delivered state yet, getContextUsage hasn't fired, etc.) doesn't clobber
  // the cache-first hydration above. wsReadyState / onStop / onInterrupt are
  // always non-cached and always written through.
  useEffect(() => {
    statusBarSet({
      ...(state ? { state } : {}),
      wsReadyState,
      ...(contextUsage ? { contextUsage } : {}),
      ...(sessionResult ? { sessionResult } : {}),
      onStop: stop,
      onInterrupt: interrupt,
      ...(kataState ? { kataState } : {}),
    })
  }, [state, wsReadyState, contextUsage, sessionResult, stop, interrupt, kataState, statusBarSet])

  // Write-through to the persistent cache on every meaningful live change so
  // the next tab switch can hydrate instantly. Skips writes when everything
  // is still null (nothing to cache yet).
  useEffect(() => {
    if (!state && !contextUsage && !kataState && !sessionResult) return
    writeSessionStatusCache(sessionId, {
      state: state ?? null,
      contextUsage: contextUsage ?? null,
      kataState: kataState ?? null,
      sessionResult: sessionResult ?? null,
    })
  }, [sessionId, state, contextUsage, kataState, sessionResult])

  useEffect(() => {
    return () => statusBarClear()
  }, [statusBarClear])

  // Fetch worktree info for the current project and keep it refreshed
  const projectName = state?.project
  const worktreeInterval = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!projectName) {
      statusBarSet({ worktreeInfo: null })
      return
    }

    const fetchWorktreeInfo = () => {
      fetch('/api/gateway/projects/all')
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => {
          const match = (data as ProjectInfo[]).find((p) => p.name === projectName)
          if (match) {
            const worktreeInfo = {
              name: match.name,
              branch: match.branch,
              dirty: match.dirty,
              ahead: match.ahead ?? 0,
              behind: match.behind ?? 0,
              pr: match.pr ?? null,
            }
            statusBarSet({ worktreeInfo })
            // Write-through so the next tab switch renders the branch + PR
            // info without waiting on /api/gateway/projects/all again.
            writeSessionStatusCache(sessionId, { worktreeInfo })
          }
        })
        .catch(() => {})
    }

    fetchWorktreeInfo()
    worktreeInterval.current = setInterval(fetchWorktreeInfo, 30_000)

    return () => {
      if (worktreeInterval.current) clearInterval(worktreeInterval.current)
    }
  }, [projectName, sessionId, statusBarSet])

  const handleSendSuggestion = useCallback(
    (text: string) => {
      sendMessage(text)
    },
    [sendMessage],
  )

  const status = state?.status ?? 'idle'

  // Draft key scopes localStorage drafts. Now that tabs ARE sessions (Yjs
  // Y.Array of sessionIds), use sessionId directly — no separate tab ID.
  const draftKey = sessionId

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
      data-testid="agent-detail-view"
    >
      <KataStatePanel kataState={kataState} />

      <div className="flex items-center justify-end px-4 py-1">
        <ConversationDownload messages={messages} sessionId={state?.session_id ?? 'unknown'} />
      </div>

      <ChatThread
        messages={messages}
        gate={state?.gate ?? null}
        status={status}
        state={state}
        isConnecting={isConnecting}
        onResolveGate={resolveGate}
        onQaResolved={injectQaPair}
        onRewind={rewind}
        branchInfo={branchInfo}
        onBranchNavigate={navigateBranch}
        onSendSuggestion={handleSendSuggestion}
      />

      <StatusBar />
      <MessageInput
        onSend={sendMessage}
        submitDraft={submitDraft}
        sessionId={sessionId}
        disabled={status === 'waiting_gate'}
        status={state?.status}
        onStop={stop}
        onInterrupt={interrupt}
        draftKey={draftKey}
      />
    </div>
  )
}
