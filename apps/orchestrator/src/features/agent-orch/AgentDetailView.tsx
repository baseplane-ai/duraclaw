/**
 * AgentDetailView — Live status display for a single SessionDO instance.
 */

import { useEffect } from 'react'
import { StatusBar } from '~/components/status-bar'
import { useStatusBarStore } from '~/stores/status-bar'
import { ChatThread } from './ChatThread'
import { KataStatePanel } from './KataStatePanel'
import { MessageInput } from './MessageInput'
import type { UseCodingAgentResult } from './use-coding-agent'

interface AgentDetailViewProps {
  name: string
  agent: UseCodingAgentResult
}

export function AgentDetailView({ name: _name, agent }: AgentDetailViewProps) {
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

  const status = state?.status ?? 'idle'
  const isTerminal = status === 'failed' || status === 'aborted'

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="agent-detail-view">
      <KataStatePanel kataState={kataState} />

      <ChatThread
        messages={messages}
        gate={state?.gate ?? null}
        status={status}
        state={state}
        isConnecting={isConnecting}
        onResolveGate={resolveGate}
        readOnly={isTerminal}
        onQaResolved={injectQaPair}
        onRewind={isTerminal ? undefined : rewind}
        branchInfo={branchInfo}
        onBranchNavigate={navigateBranch}
      />

      <StatusBar />
      <MessageInput onSend={sendMessage} disabled={isTerminal} />
    </div>
  )
}
