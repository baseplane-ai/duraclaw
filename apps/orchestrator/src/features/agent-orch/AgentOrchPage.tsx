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
        addTab(sessionId, config.prompt?.slice(0, 40) || config.project)
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
      // Find session to get its title
      const session = sessions.find((s) => s.id === sessionId)
      const title =
        session?.title || getPreviewText(session ?? { prompt: undefined }) || sessionId.slice(0, 12)
      addTab(sessionId, title)
      navigate({ to: '/', search: { session: sessionId } })
    },
    [navigate, addTab, sessions],
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
      <Header fixed />
      <Main fixed fluid className="p-0">
        <PwaInstallBanner />
        <PushOptInBanner />
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
  const updateTabTitle = useTabStore((s) => s.updateTabTitle)

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
      if (title) updateTabTitle(sessionId, title)
    }
  }, [agent.state, sessionId, onStateChange, updateTabTitle])

  return <AgentDetailView name={sessionId} agent={agent} />
}
