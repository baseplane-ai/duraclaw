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
import { PushOptInBanner } from '~/components/push-opt-in-banner'
import { PwaInstallBanner } from '~/components/pwa-install-banner'
import { QuickPromptInput } from '~/components/quick-prompt-input'
import { TabBar } from '~/components/tab-bar'
import { cn } from '~/lib/utils'
import { useTabStore } from '~/stores/tabs'
import { AgentDetailView } from './AgentDetailView'
import { SessionCardList } from './SessionCardList'
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
  const [projects, setProjects] = useState<Array<{ name: string; path: string }>>([])
  const [projectsLoading, setProjectsLoading] = useState(true)

  useEffect(() => {
    fetch('/api/gateway/projects')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const d = data as Record<string, unknown> | Array<{ name: string; path: string }> | null
        const list = Array.isArray(d)
          ? d
          : ((d?.projects as Array<{ name: string; path: string }>) ?? [])
        setProjects(list)
      })
      .catch(() => {})
      .finally(() => setProjectsLoading(false))
  }, [])

  const addTab = useTabStore((s) => s.addTab)

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
        addTab(sessionId)
        navigate({ to: '/', search: { session: sessionId } })
      } catch (err) {
        console.error('[AgentOrch] Spawn failed:', err)
      }
    },
    [navigate, addTab],
  )

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setSpawnConfig(null)
      setSelectedSessionId(sessionId)
      addTab(sessionId)
      navigate({ to: '/', search: { session: sessionId } })
    },
    [navigate, addTab],
  )

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    const stored = localStorage.getItem('agent-orch-sidebar-collapsed')
    if (stored !== null) return stored === 'true'
    return window.innerWidth < 640
  })
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey

      // Cmd+T: add current session as tab (or no-op)
      if (isMod && e.key === 't') {
        e.preventDefault()
        if (selectedSessionId) {
          useTabStore.getState().addTab(selectedSessionId)
        }
      }

      // Cmd+W: close current tab
      if (isMod && e.key === 'w') {
        e.preventDefault()
        if (selectedSessionId) {
          useTabStore.getState().removeTab(selectedSessionId)
        }
      }

      // Cmd+1-9: switch to Nth tab
      if (isMod && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1
        const tabs = useTabStore.getState().tabs
        if (idx < tabs.length) {
          e.preventDefault()
          const tab = tabs[idx]
          useTabStore.getState().setActiveTab(tab.sessionId)
          handleSelectSession(tab.sessionId)
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedSessionId, handleSelectSession])

  return (
    <>
      <Header />
      <Main>
        <PwaInstallBanner />
        <PushOptInBanner />
        <div className="flex h-[calc(100vh-4rem-28px)] overflow-hidden">
          {/* Desktop: sidebar */}
          <div className="hidden sm:block">
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
          </div>
          {/* Mobile: card list (only shown when no session is selected) */}
          <div
            className={cn(
              'sm:hidden',
              selectedSessionId ? 'hidden' : 'flex h-full flex-col w-full overflow-hidden',
            )}
          >
            <SessionCardList
              sessions={sessions}
              selectedSessionId={selectedSessionId}
              onSelectSession={handleSelectSession}
              onArchiveSession={handleArchiveSession}
            />
          </div>
          <div className="flex flex-1 flex-col overflow-hidden">
            <TabBar onSelectSession={handleSelectSession} />
            {selectedSessionId ? (
              <AgentDetailWithSpawn
                key={selectedSessionId}
                sessionId={selectedSessionId}
                spawnConfig={spawnConfig}
                onStateChange={handleStateChange}
              />
            ) : (
              <QuickPromptInput
                onSubmit={handleSpawn}
                projects={projects}
                projectsLoading={projectsLoading}
              />
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
