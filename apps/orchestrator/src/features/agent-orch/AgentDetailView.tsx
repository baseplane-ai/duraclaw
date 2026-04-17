/**
 * AgentDetailView — Live status display for a single SessionDO instance.
 */

import { useCallback, useEffect, useRef } from 'react'
import { StatusBar } from '~/components/status-bar'
import { useUserSettings } from '~/hooks/use-user-settings'
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

  useEffect(() => {
    statusBarSet({
      state,
      wsReadyState,
      contextUsage: contextUsage ?? null,
      sessionResult: sessionResult ?? null,
      onStop: stop,
      onInterrupt: interrupt,
      kataState: kataState ?? null,
    })
  }, [state, wsReadyState, contextUsage, sessionResult, stop, interrupt, kataState, statusBarSet])

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
            statusBarSet({
              worktreeInfo: {
                name: match.name,
                branch: match.branch,
                dirty: match.dirty,
                ahead: match.ahead ?? 0,
                behind: match.behind ?? 0,
                pr: match.pr ?? null,
              },
            })
          }
        })
        .catch(() => {})
    }

    fetchWorktreeInfo()
    worktreeInterval.current = setInterval(fetchWorktreeInfo, 30_000)

    return () => {
      if (worktreeInterval.current) clearInterval(worktreeInterval.current)
    }
  }, [projectName, statusBarSet])

  const handleSendSuggestion = useCallback(
    (text: string) => {
      sendMessage(text)
    },
    [sendMessage],
  )

  const status = state?.status ?? 'idle'
  const isTerminal = status === 'aborted'

  // Resolve the tab that owns this session so MessageInput can persist its draft.
  // Use the sessionId prop (always available) instead of state?.session_id
  // (requires WS) to avoid a key-change remount that would lose typed text.
  const { findTabBySession } = useUserSettings()
  const tabId = findTabBySession(sessionId)?.id

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
        disabled={isTerminal}
        draftKey={tabId}
      />
    </div>
  )
}
