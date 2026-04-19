/**
 * AgentDetailView — Live status display for a single SessionDO instance.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { StatusBar } from '~/components/status-bar'
import { readSessionStatusCache, writeSessionStatusCache } from '~/db/session-status-collection'
import type { ProjectInfo } from '~/lib/types'
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
    if (!cached) return
    statusBarSet({
      state: cached.state,
      contextUsage: cached.contextUsage,
      kataState: cached.kataState,
      worktreeInfo: cached.worktreeInfo,
      sessionResult: cached.sessionResult,
    })
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
        draftKey={draftKey}
      />
    </div>
  )
}
