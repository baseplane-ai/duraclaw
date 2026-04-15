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
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { useSwipeTabs } from '~/hooks/use-swipe-tabs'
import { useTabStore } from '~/stores/tabs'
import { AgentDetailView } from './AgentDetailView'
import type { SpawnFormConfig } from './SpawnAgentForm'
import { getPreviewText } from './session-utils'
import { type SpawnConfig, useCodingAgent } from './use-coding-agent'

export function AgentOrchPage() {
  return <AgentOrchContent />
}

function AgentOrchContent() {
  const { sessions, updateSession } = useSessionsCollection()
  const search = useSearch({ from: '/_authenticated/' })
  const navigate = useNavigate()
  const searchSessionId = (search as { session?: string }).session ?? null
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(searchSessionId)
  const [spawnConfig, setSpawnConfig] = useState<SpawnConfig | null>(null)

  // Sync selectedSessionId when URL search param changes (e.g. sidebar navigation)
  useEffect(() => {
    if (searchSessionId && searchSessionId !== selectedSessionId) {
      setSpawnConfig(null)
      setSelectedSessionId(searchSessionId)
    }
  }, [searchSessionId, selectedSessionId])
  const [projects, setProjects] = useState<
    Array<{ name: string; path: string; repo_origin?: string | null }>
  >([])
  const [projectsLoading, setProjectsLoading] = useState(true)

  useEffect(() => {
    fetch('/api/gateway/projects')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const d = data as
          | Record<string, unknown>
          | Array<{ name: string; path: string; repo_origin?: string | null }>
          | null
        const list = Array.isArray(d)
          ? d.map((p: any) => ({ name: p.name, path: p.path, repo_origin: p.repo_origin ?? null }))
          : ((d?.projects as Array<{ name: string; path: string; repo_origin?: string | null }>) ??
            [])
        setProjects(list)
      })
      .catch(() => {})
      .finally(() => setProjectsLoading(false))
  }, [])

  const { addTab, addNewTab } = useTabStore()

  const handleSpawn = useCallback(
    async (config: SpawnFormConfig & { newTab?: boolean }) => {
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
        const title = config.prompt?.slice(0, 40) || config.project

        // Set spawn config for auto-spawn in AgentDetailWithSpawn
        setSpawnConfig({
          project: config.project,
          prompt: config.prompt,
          model: config.model,
          agent: config.agent,
        })
        setSelectedSessionId(sessionId)

        // Add to tab: replace existing project tab or force new tab
        if (config.newTab) {
          addNewTab(config.project, sessionId, title)
        } else {
          addTab(config.project, sessionId, title)
        }

        navigate({ to: '/', search: { session: sessionId } })
      } catch (err) {
        console.error('[AgentOrch] Spawn failed:', err)
      }
    },
    [navigate, addTab, addNewTab],
  )

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId)
      const title =
        session?.title || getPreviewText(session ?? { prompt: undefined }) || sessionId.slice(0, 12)
      const project = session?.project || 'unknown'
      addTab(project, sessionId, title)
      setSpawnConfig(null)
      setSelectedSessionId(sessionId)
      navigate({ to: '/', search: { session: sessionId } })
    },
    [navigate, addTab, sessions],
  )

  const handleLastTabClosed = useCallback(() => {
    setSpawnConfig(null)
    setSelectedSessionId(null)
    navigate({ to: '/' })
  }, [navigate])

  const handleStateChange = useCallback(
    (sessionId: string, patch: Record<string, unknown>) => {
      updateSession(sessionId, patch)
    },
    [updateSession],
  )

  const { swipeProps, debug: swipeDebug } = useSwipeTabs(handleSelectSession)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey

      // Cmd+T: add current session as tab (or no-op)
      if (isMod && e.key === 't') {
        e.preventDefault()
        if (selectedSessionId) {
          const session = sessions.find((s) => s.id === selectedSessionId)
          const project = session?.project || 'unknown'
          useTabStore.getState().addTab(project, selectedSessionId)
        }
      }

      // Cmd+W: close current tab
      if (isMod && e.key === 'w') {
        e.preventDefault()
        const { tabs, activeTabId } = useTabStore.getState()
        if (activeTabId) {
          useTabStore.getState().removeTab(activeTabId)
          if (tabs.length <= 1) {
            handleLastTabClosed()
          }
        }
      }

      // Cmd+1-9: switch to Nth tab
      if (isMod && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1
        const tabs = useTabStore.getState().tabs
        if (idx < tabs.length) {
          e.preventDefault()
          const tab = tabs[idx]
          useTabStore.getState().setActiveTab(tab.id)
          handleSelectSession(tab.sessionId)
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedSessionId, sessions, handleSelectSession, handleLastTabClosed])

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
        <PwaInstallBanner />
        <PushOptInBanner />
        <TabBar onSelectSession={handleSelectSession} onLastTabClosed={handleLastTabClosed} />
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

  // Sync DO state changes to registry + update tab title from summary
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
