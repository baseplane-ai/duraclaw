/**
 * AgentDetailView — Live status display for a single SessionDO instance.
 */

import { ChatThread } from './ChatThread'
import { KataStatePanel } from './KataStatePanel'
import { MessageInput } from './MessageInput'
import { SessionMetadataHeader } from './SessionMetadataHeader'
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
    wsReadyState,
    stop,
    resolveGate,
    sendMessage,
    rewind,
    injectQaPair,
  } = agent

  const status = state?.status ?? 'idle'
  const isTerminal = status === 'failed' || status === 'aborted'
  const isResumable = (status === 'idle' || status === 'completed') && !!state?.started_at
  const canSend = status === 'running' || status === 'waiting_gate' || isResumable

  return (
    <div className="flex h-full flex-col" data-testid="agent-detail-view">
      <SessionMetadataHeader
        state={state}
        onStop={stop}
        sessionResult={sessionResult}
        wsReadyState={wsReadyState}
      />
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

      {canSend && <MessageInput onSend={sendMessage} disabled={!canSend} />}
    </div>
  )
}
