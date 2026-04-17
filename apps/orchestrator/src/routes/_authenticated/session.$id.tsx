import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
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

  // Sync tab store on mount — synchronous via initializer pattern
  const [_initDone] = useState(() => {
    const session = sessions.find((s) => s.id === sessionId)
    const title =
      session?.title || getPreviewText(session ?? { prompt: undefined }) || sessionId.slice(0, 12)
    const project = session?.project || 'unknown'
    useTabStore.getState().activateSession(sessionId, { project, title })
    return true
  })

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

  const { swipeProps, swipeDir } = useSwipeTabs(handleSelectSession)

  return (
    <>
      <Header fixed />
      <Main fixed fluid className="p-0" {...swipeProps}>
        <TabBar
          activeSessionId={sessionId}
          onSelectSession={handleSelectSession}
          onLastTabClosed={handleLastTabClosed}
        />
        <div
          className={
            swipeDir === 'left'
              ? 'animate-slide-out-left'
              : swipeDir === 'right'
                ? 'animate-slide-out-right'
                : 'animate-slide-in'
          }
          style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' }}
        >
          <SessionDetailWithSync
            key={sessionId}
            sessionId={sessionId}
            onStateChange={handleStateChange}
          />
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
