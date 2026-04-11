/**
 * AgentOrchPage — Main page for spawning and observing sessions.
 *
 * Layout: sidebar (session list + spawn form) + main area (selected agent detail view).
 * Adapted from baseplane: uses ProjectRegistry instead of DataForge,
 * duraclaw's TanStack Router, and SessionDO instead of CodingAgent.
 */

import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { AgentDetailView } from './AgentDetailView'
import { SessionSidebar } from './SessionSidebar'
import type { SpawnFormConfig } from './SpawnAgentForm'
import { useAgentOrchSessions } from './use-agent-orch-sessions'
import { type SpawnConfig, useCodingAgent } from './use-coding-agent'

export function AgentOrchPage() {
  return <AgentOrchContent />
}

function AgentOrchContent() {
  const { sessions, updateSession, archiveSession } = useAgentOrchSessions()
  const search = useSearch({ from: '/_authenticated/' })
  const navigate = useNavigate()
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    (search as { session?: string }).session ?? null,
  )
  const [spawnConfig, setSpawnConfig] = useState<SpawnConfig | null>(null)

  const handleSpawn = useCallback(
    async (config: SpawnFormConfig) => {
      // Create session via the existing POST /api/sessions route
      try {
        const resp = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: config.project,
            prompt: config.prompt,
            model: config.model,
            agent: config.agent,
          }),
        })
        if (!resp.ok) return

        const data = (await resp.json()) as { session_id: string }
        const sessionId = data.session_id

        // Set spawn config for auto-spawn in AgentDetailWithSpawn
        setSpawnConfig({
          project: config.project,
          prompt: config.prompt,
          model: config.model,
          agent: config.agent,
        })
        setSelectedSessionId(sessionId)
        navigate({ to: '/', search: { session: sessionId } })
      } catch (err) {
        console.error('[AgentOrch] Spawn failed:', err)
      }
    },
    [navigate],
  )

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setSpawnConfig(null)
      setSelectedSessionId(sessionId)
      navigate({ to: '/', search: { session: sessionId } })
    },
    [navigate],
  )

  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () =>
      typeof window !== 'undefined' &&
      localStorage.getItem('agent-orch-sidebar-collapsed') === 'true',
  )
  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      localStorage.setItem('agent-orch-sidebar-collapsed', String(next))
      return next
    })
  }, [])

  const handleArchiveSession = useCallback(
    (sessionId: string, archived: boolean) => {
      archiveSession(sessionId, archived)
    },
    [archiveSession],
  )

  const handleRenameSession = useCallback(
    (sessionId: string, title: string) => {
      updateSession(sessionId, { title })
    },
    [updateSession],
  )

  const handleTagSession = useCallback(
    (sessionId: string, tag: string | null) => {
      updateSession(sessionId, { tag })
    },
    [updateSession],
  )

  const handleForkSession = useCallback(
    async (sessionId: string) => {
      try {
        const resp = await fetch(`/api/sessions/${sessionId}/fork`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (!resp.ok) {
          const err = (await resp.json()) as { error?: string }
          console.error('[AgentOrch] Fork failed:', err.error)
          return
        }
        const data = (await resp.json()) as { session_id: string }
        // Select the forked session
        if (data.session_id) {
          setSelectedSessionId(data.session_id)
          navigate({ to: '/', search: { session: data.session_id } })
        }
      } catch (err) {
        console.error('[AgentOrch] Fork failed:', err)
      }
    },
    [navigate],
  )

  const handleStateChange = useCallback(
    (sessionId: string, patch: Record<string, unknown>) => {
      updateSession(sessionId, patch)
    },
    [updateSession],
  )

  return (
    <>
      <Header />
      <Main>
        <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
          <SessionSidebar
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={handleSelectSession}
            onSpawn={handleSpawn}
            onArchiveSession={handleArchiveSession}
            onRenameSession={handleRenameSession}
            onTagSession={handleTagSession}
            onForkSession={handleForkSession}
            collapsed={sidebarCollapsed}
            onToggleCollapse={handleToggleSidebar}
          />
          <div className="flex flex-1 flex-col overflow-hidden">
            {selectedSessionId ? (
              <AgentDetailWithSpawn
                key={selectedSessionId}
                sessionId={selectedSessionId}
                spawnConfig={spawnConfig}
                onStateChange={handleStateChange}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  Select a session or create a new one
                </p>
              </div>
            )}
          </div>
        </div>
      </Main>
    </>
  )
}

/**
 * Wrapper that auto-spawns the agent once the WS connection delivers initial state.
 */
function AgentDetailWithSpawn({
  sessionId,
  spawnConfig,
  onStateChange,
}: {
  sessionId: string
  spawnConfig: SpawnConfig | null
  onStateChange: (sessionId: string, patch: Record<string, unknown>) => void
}) {
  const agent = useCodingAgent(sessionId)
  const spawnedRef = useRef(false)

  // Spawn once we have state (WS is connected and synced)
  useEffect(() => {
    if (spawnConfig && agent.state && !spawnedRef.current) {
      spawnedRef.current = true
      agent.spawn(spawnConfig).catch((err: unknown) => {
        console.error('[AgentOrch] Spawn failed:', err)
      })
    }
  }, [spawnConfig, agent.state, agent.spawn])

  // Sync DO state changes to registry
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
