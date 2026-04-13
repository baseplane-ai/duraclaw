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
    streamingContent,
    sessionResult,
    kataState,
    contextUsage,
    wsReadyState,
    stop,
    interrupt,
    resolveGate,
    sendMessage,
    rewind,
    injectQaPair,
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
  const isResumable = status === 'idle' && !!state?.started_at
  const canSend = status === 'running' || status === 'waiting_gate' || isResumable

  return (
    <div className="flex h-full flex-col" data-testid="agent-detail-view">
      <KataStatePanel kataState={kataState} />

      <ChatThread
        messages={messages}
        gate={state?.gate ?? null}
        status={status}
        state={state}
        onResolveGate={resolveGate}
        readOnly={isTerminal}
        streamingContent={isTerminal ? undefined : streamingContent}
        onQaResolved={injectQaPair}
        onRewind={isTerminal ? undefined : rewind}
      />

      <StatusBar />
      {canSend && <MessageInput onSend={sendMessage} disabled={!canSend} />}
    </div>
  )
}
