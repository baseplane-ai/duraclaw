/**
 * AgentOrchPage — Main page for spawning and observing sessions.
 *
 * Layout: sidebar (session list + spawn form) + main area (selected agent detail view).
 * Tab state is Yjs-backed via useTabSync — no TanStack QueryCollection, no
 * optimistic inserts, no server dedup. The Y.Array<string> of session IDs IS
 * the tab list; display metadata comes from agentSessionsCollection join.
 */

import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { PushOptInBanner } from '~/components/push-opt-in-banner'
import { PwaInstallBanner } from '~/components/pwa-install-banner'
import { QuickPromptInput } from '~/components/quick-prompt-input'
import { TabBar } from '~/components/tab-bar'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { useSwipeTabs } from '~/hooks/use-swipe-tabs'
import { getTabSyncSnapshot, useTabSync } from '~/hooks/use-tab-sync'
import { AgentDetailView } from './AgentDetailView'
import type { SpawnFormConfig } from './SpawnAgentForm'
import { type SpawnConfig, useCodingAgent } from './use-coding-agent'

export function AgentOrchPage() {
  return <AgentOrchContent />
}

function AgentOrchContent() {
  const { sessions } = useSessionsCollection()
  const search = useSearch({ from: '/_authenticated/' })
  const navigate = useNavigate()
  const searchSessionId = (search as { session?: string }).session ?? null
  const searchNewSessionProject =
    (search as { newSessionProject?: string }).newSessionProject ?? null
  const searchNewTab = (search as { newTab?: boolean }).newTab ?? false

  // Session→project resolver for one-tab-per-project enforcement inside useTabSync.
  const sessionProjectMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of sessions) {
      if (s.project) m.set(s.id, s.project)
    }
    return m
  }, [sessions])
  const projectResolver = useCallback(
    (sessionId: string) => sessionProjectMap.get(sessionId),
    [sessionProjectMap],
  )

  // ── Yjs tab sync — one-tab-per-project enforced inside the hook ──
  const { openTabs, activeSessionId, openTab, closeTab, setActive, reorder } = useTabSync({
    projectResolver,
  })

  // Deep-link: if URL has ?session=X, ensure it's in open tabs + activate.
  // One-tab-per-project is handled automatically by openTab's projectResolver.
  const deepLinkedRef = useRef<string | null>(null)
  useEffect(() => {
    if (searchSessionId && searchSessionId !== deepLinkedRef.current) {
      deepLinkedRef.current = searchSessionId
      openTab(searchSessionId)
    }
  }, [searchSessionId, openTab])

  // Sync URL when activeSessionId changes (Yjs → URL).
  useEffect(() => {
    const currentUrlSession = (search as { session?: string }).session ?? null
    if (activeSessionId && activeSessionId !== currentUrlSession) {
      navigate({ to: '/', search: { session: activeSessionId }, replace: true })
    } else if (!activeSessionId && currentUrlSession) {
      navigate({ to: '/', search: {}, replace: true })
    }
  }, [activeSessionId, search, navigate])

  const [spawnConfig, setSpawnConfig] = useState<SpawnConfig | null>(null)
  const [quickPromptHint, setQuickPromptHint] = useState<{
    project: string
    newTab: boolean
  } | null>(() =>
    searchNewSessionProject ? { project: searchNewSessionProject, newTab: searchNewTab } : null,
  )

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

  const handleSpawn = useCallback(
    async (config: SpawnFormConfig & { newTab?: boolean }) => {
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

        setSpawnConfig({
          project: config.project,
          prompt: config.prompt,
          model: config.model,
          agent: config.agent,
        })
        setQuickPromptHint(null)

        // openTab handles one-tab-per-project automatically; "New tab for
        // project" passes forceNewTab to explicitly create a second tab.
        openTab(sessionId, { forceNewTab: config.newTab })
        navigate({ to: '/', search: { session: sessionId } })
      } catch (err) {
        console.error('[AgentOrch] Spawn failed:', err)
      }
    },
    [navigate, openTab],
  )

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      // openTab is idempotent (no-op + activate if already open) and
      // handles one-tab-per-project replacement automatically.
      openTab(sessionId)
      setSpawnConfig(null)
      navigate({ to: '/', search: { session: sessionId } })
    },
    [navigate, openTab],
  )

  const handleCloseTab = useCallback(
    (sessionId: string) => {
      const isLastTab = openTabs.length === 1
      const nextActive = closeTab(sessionId)
      if (isLastTab || !nextActive) {
        setSpawnConfig(null)
        setQuickPromptHint(null)
        navigate({ to: '/' })
      } else {
        navigate({ to: '/', search: { session: nextActive } })
      }
    },
    [openTabs, closeTab, navigate],
  )

  const handleNewSessionInTab = useCallback(
    (project: string) => {
      setSpawnConfig(null)
      setActive(null)
      setQuickPromptHint({ project, newTab: false })
      navigate({ to: '/' })
    },
    [navigate, setActive],
  )

  const handleNewTabForProject = useCallback(
    (project: string) => {
      setSpawnConfig(null)
      setActive(null)
      setQuickPromptHint({ project, newTab: true })
      navigate({ to: '/' })
    },
    [navigate, setActive],
  )

  const { swipeProps, swipeDir } = useSwipeTabs(handleSelectSession, activeSessionId)

  // ── Keyboard shortcuts ───────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey

      // Cmd+T: no-op for now (browser intercepts); could open new session
      if (isMod && e.key === 't') {
        e.preventDefault()
      }

      // Cmd+W: close active tab
      if (isMod && e.key === 'w') {
        e.preventDefault()
        const { activeSessionId: active } = getTabSyncSnapshot()
        if (active) {
          handleCloseTab(active)
        }
      }

      // Cmd+1-9: switch to Nth tab
      if (isMod && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1
        const { openTabs: tabs } = getTabSyncSnapshot()
        const sessionId = tabs[idx]
        if (sessionId) {
          e.preventDefault()
          handleSelectSession(sessionId)
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSelectSession, handleCloseTab])

  return (
    <>
      <Header fixed />
      <Main fixed fluid className="p-0" {...swipeProps}>
        <PwaInstallBanner />
        <PushOptInBanner />
        <TabBar
          openTabs={openTabs}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onCloseTab={handleCloseTab}
          onReorder={reorder}
          onNewSessionInTab={handleNewSessionInTab}
          onNewTabForProject={handleNewTabForProject}
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
          {activeSessionId ? (
            <AgentDetailWithSpawn
              key={activeSessionId}
              sessionId={activeSessionId}
              spawnConfig={spawnConfig}
            />
          ) : (
            <QuickPromptInput
              key={
                quickPromptHint
                  ? `hint-${quickPromptHint.project}-${quickPromptHint.newTab}`
                  : 'default'
              }
              onSubmit={handleSpawn}
              projects={projects}
              projectsLoading={projectsLoading}
              initialProject={quickPromptHint?.project}
              initialNewTab={quickPromptHint?.newTab}
            />
          )}
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
}: {
  sessionId: string
  spawnConfig: SpawnConfig | null
}) {
  const agent = useCodingAgent(sessionId)
  const spawnedRef = useRef(false)

  useEffect(() => {
    if (spawnConfig && agent.state && !spawnedRef.current) {
      spawnedRef.current = true
      agent.spawn(spawnConfig).catch((err: unknown) => {
        console.error('[AgentOrch] Spawn failed:', err)
      })
    }
  }, [spawnConfig, agent.state, agent.spawn])

  return <AgentDetailView name={sessionId} agent={agent} />
}
