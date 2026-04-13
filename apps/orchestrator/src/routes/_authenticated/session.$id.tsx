import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { TabBar } from '~/components/tab-bar'
import { AgentDetailView } from '~/features/agent-orch/AgentDetailView'
import { getPreviewText } from '~/features/agent-orch/session-utils'
import { useAgentOrchSessions } from '~/features/agent-orch/use-agent-orch-sessions'
import { useCodingAgent } from '~/features/agent-orch/use-coding-agent'
import { useTabStore } from '~/stores/tabs'

export const Route = createFileRoute('/_authenticated/session/$id')({
  component: SessionDetailPage,
})

function SessionDetailPage() {
  const { id: sessionId } = Route.useParams()
  const navigate = useNavigate()
  const { sessions, updateSession } = useAgentOrchSessions()
  const addTab = useTabStore((s) => s.addTab)

  useEffect(() => {
    const session = sessions.find((s) => s.id === sessionId)
    const title =
      session?.title || getPreviewText(session ?? { prompt: undefined }) || sessionId.slice(0, 12)
    addTab(sessionId, title)
  }, [sessionId, addTab, sessions])

  const handleSelectSession = useCallback(
    (sid: string) => {
      const session = sessions.find((s) => s.id === sid)
      const title =
        session?.title || getPreviewText(session ?? { prompt: undefined }) || sid.slice(0, 12)
      addTab(sid, title)
      navigate({ to: '/session/$id', params: { id: sid } })
    },
    [navigate, addTab, sessions],
  )

  const handleStateChange = useCallback(
    (sid: string, patch: Record<string, unknown>) => {
      updateSession(sid, patch)
    },
    [updateSession],
  )

  return (
    <>
      <Header />
      <Main>
        <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden">
          <TabBar onSelectSession={handleSelectSession} />
          <SessionDetailWithSync sessionId={sessionId} onStateChange={handleStateChange} />
        </div>
      </Main>
    </>
  )
}

function SessionDetailWithSync({
  sessionId,
  onStateChange,
}: {
  sessionId: string
  onStateChange: (sessionId: string, patch: Record<string, unknown>) => void
}) {
  const agent = useCodingAgent(sessionId)
  const prevStateRef = useRef(agent.state)

  useEffect(() => {
    if (agent.state && agent.state !== prevStateRef.current) {
      prevStateRef.current = agent.state
      onStateChange(sessionId, {
        status: agent.state.status,
        num_turns: agent.state.num_turns,
        error: agent.state.error,
      })
    }
  }, [agent.state, sessionId, onStateChange])

  return <AgentDetailView name={sessionId} agent={agent} />
}
