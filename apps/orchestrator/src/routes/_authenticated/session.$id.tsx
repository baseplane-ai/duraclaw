import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { Button } from '~/components/ui/button'
import { AgentDetailView } from '~/features/agent-orch/AgentDetailView'
import { SessionSidebar } from '~/features/agent-orch/SessionSidebar'
import { useAgentOrchSessions } from '~/features/agent-orch/use-agent-orch-sessions'
import { useCodingAgent } from '~/features/agent-orch/use-coding-agent'
import { useTabStore } from '~/stores/tabs'

export const Route = createFileRoute('/_authenticated/session/$id')({
  component: SessionDetailPage,
})

function SessionDetailPage() {
  const { id: sessionId } = Route.useParams()
  const navigate = useNavigate()
  const { sessions, updateSession, archiveSession } = useAgentOrchSessions()
  const addTab = useTabStore((s) => s.addTab)

  useEffect(() => {
    addTab(sessionId)
  }, [sessionId, addTab])

  const handleSelectSession = useCallback(
    (sid: string) => {
      addTab(sid)
      navigate({ to: '/session/$id', params: { id: sid } })
    },
    [navigate, addTab],
  )

  const handleBack = useCallback(() => {
    navigate({ to: '/' })
  }, [navigate])

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
        <div className="flex h-[calc(100vh-4rem-28px)] overflow-hidden">
          {/* Desktop: show sidebar */}
          <div className="hidden sm:block">
            <SessionSidebar
              sessions={sessions}
              selectedSessionId={sessionId}
              onSelectSession={handleSelectSession}
              onSpawn={() => {}}
              onArchiveSession={(sid, archived) => archiveSession(sid, archived)}
              onRenameSession={(sid, title) => updateSession(sid, { title })}
              onTagSession={(sid, tag) => updateSession(sid, { tag })}
              onForkSession={() => {}}
            />
          </div>
          {/* Detail view */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Mobile: back button */}
            <div className="sm:hidden border-b px-3 py-2">
              <Button variant="ghost" size="sm" onClick={handleBack} className="gap-1">
                <ArrowLeftIcon className="size-4" />
                Sessions
              </Button>
            </div>
            <SessionDetailWithSync sessionId={sessionId} onStateChange={handleStateChange} />
          </div>
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
