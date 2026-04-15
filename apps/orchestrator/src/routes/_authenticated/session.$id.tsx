import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { TabBar } from '~/components/tab-bar'
import { AgentDetailView } from '~/features/agent-orch/AgentDetailView'
import { getPreviewText } from '~/features/agent-orch/session-utils'
import { useCodingAgent } from '~/features/agent-orch/use-coding-agent'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { useSwipeTabs } from '~/hooks/use-swipe-tabs'
import { useTabStore } from '~/stores/tabs'

export const Route = createFileRoute('/_authenticated/session/$id')({
  component: SessionDetailPage,
})

function SessionDetailPage() {
  const { id: sessionId } = Route.useParams()
  const navigate = useNavigate()
  const { sessions, updateSession } = useSessionsCollection()
  const addTab = useTabStore((s) => s.addTab)

  useEffect(() => {
    const session = sessions.find((s) => s.id === sessionId)
    const title =
      session?.title || getPreviewText(session ?? { prompt: undefined }) || sessionId.slice(0, 12)
    const project = session?.project || 'unknown'
    addTab(project, sessionId, title)
  }, [sessionId, addTab, sessions])

  const handleSelectSession = useCallback(
    (sid: string) => {
      const session = sessions.find((s) => s.id === sid)
      const title =
        session?.title || getPreviewText(session ?? { prompt: undefined }) || sid.slice(0, 12)
      const project = session?.project || 'unknown'
      addTab(project, sid, title)
      navigate({ to: '/', search: { session: sid } })
    },
    [navigate, addTab, sessions],
  )

  const handleLastTabClosed = useCallback(() => {
    navigate({ to: '/' })
  }, [navigate])

  const handleStateChange = useCallback(
    (sid: string, patch: Record<string, unknown>) => {
      updateSession(sid, patch)
    },
    [updateSession],
  )

  const { swipeProps, debug: swipeDebug } = useSwipeTabs(handleSelectSession)

  return (
    <>
      <Header fixed />
      <Main fixed fluid className="p-0" {...swipeProps}>
        {swipeDebug && (
          <div
            className="fixed top-16 left-1/2 z-[9999] -translate-x-1/2 rounded-lg px-4 py-2 text-xs font-mono shadow-lg"
            style={{
              backgroundColor: swipeDebug.active ? '#22c55e' : '#ef4444',
              color: 'white',
            }}
          >
            {swipeDebug.active ? 'SWIPE' : 'REJECTED'} {swipeDebug.dir} | dx:
            {Math.round(swipeDebug.dx)} dy:{Math.round(swipeDebug.dy)} start:
            {Math.round(swipeDebug.startX)}
            {swipeDebug.rejected && ` | ${swipeDebug.rejected}`}
          </div>
        )}
        <TabBar onSelectSession={handleSelectSession} onLastTabClosed={handleLastTabClosed} />
        <SessionDetailWithSync
          key={sessionId}
          sessionId={sessionId}
          onStateChange={handleStateChange}
        />
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
      // Update tab title when session gets a summary
      const title = agent.state.summary || agent.state.project
      if (title) {
        const tab = useTabStore.getState().findTabBySession(sessionId)
        if (tab) useTabStore.getState().updateTabTitle(tab.id, title)
      }
    }
  }, [agent.state, sessionId, onStateChange])

  return <AgentDetailView name={sessionId} agent={agent} />
}
