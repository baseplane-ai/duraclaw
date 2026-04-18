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
import { lookupSessionInCache } from '~/db/sessions-cache-shim'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { useSwipeTabs } from '~/hooks/use-swipe-tabs'
import { getUserSettings, useUserSettings } from '~/hooks/use-user-settings'
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
  const searchNewSessionProject =
    (search as { newSessionProject?: string }).newSessionProject ?? null
  const searchNewTab = (search as { newTab?: boolean }).newTab ?? false

  const { addTab, addNewTab } = useUserSettings()

  // Synchronous init: resolve selectedSessionId from URL or last active tab.
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => {
    const settings = getUserSettings()
    if (searchSessionId) {
      // Create/merge tab SYNCHRONOUSLY using localStorage-cached session
      // metadata. This runs during the initial render — before any effects —
      // so the tab bar renders correctly on the first frame even after a
      // full page reload (push notification tap). Direct localStorage read
      // avoids any TanStack DB collection/query-layer timing issues.
      const cached = lookupSessionInCache(searchSessionId)
      if (cached) {
        settings.addTab(cached.project, searchSessionId, cached.title || cached.project)
      }
      return searchSessionId
    }
    // No URL session — restore from the last active tab (cold launch / PWA)
    const { tabs: currentTabs, activeTabId: currentActiveTabId } = settings
    if (currentActiveTabId) {
      const match = currentTabs.find((t) => t.id === currentActiveTabId)
      if (match) return match.sessionId
    }
    // Fallback: if tabs exist but none is marked active (e.g., stale activeTabId,
    // notification tap that failed to set ?session=X), select the first tab rather
    // than showing the empty "Start a conversation" state.
    if (currentTabs.length > 0) {
      const fallback = currentTabs[0]
      settings.setActiveTab(fallback.id)
      return fallback.sessionId
    }
    return null
  })
  const restoredSessionId = !searchSessionId ? selectedSessionId : null
  const [spawnConfig, setSpawnConfig] = useState<SpawnConfig | null>(null)
  // Pre-fill hints for the QuickPromptInput composer, set by tab context menu actions.
  // Seed from URL search params so the hint survives reloads / cold launches.
  const [quickPromptHint, setQuickPromptHint] = useState<{
    project: string
    newTab: boolean
  } | null>(() =>
    searchNewSessionProject ? { project: searchNewSessionProject, newTab: searchNewTab } : null,
  )

  // Strip the hint search params from the URL once consumed so reloads don't re-trigger them.
  useEffect(() => {
    if (searchNewSessionProject) {
      navigate({
        to: '/',
        search: (prev) => ({ ...prev, newSessionProject: undefined, newTab: undefined }),
        replace: true,
      })
    }
  }, [searchNewSessionProject, navigate])
  const prevSearchRef = useRef(searchSessionId)
  const didRestoreRef = useRef(false)

  // On restore, push the session into the URL so bookmarks/refresh work
  useEffect(() => {
    if (restoredSessionId && !didRestoreRef.current) {
      didRestoreRef.current = true
      navigate({ to: '/', search: { session: restoredSessionId }, replace: true })
    }
  }, [restoredSessionId, navigate])

  // Sync URL → selectedSessionId on subsequent navigations
  useEffect(() => {
    const prev = prevSearchRef.current
    prevSearchRef.current = searchSessionId

    // Tab-highlight sync: ensure the active tab matches the URL session.
    // Runs on mount too (not just on URL changes) so cold-load from a push
    // notification (/?session=X) activates or creates the matching tab —
    // otherwise activeTabId stays on a stale localStorage value and the
    // session appears with no tab focus.
    if (searchSessionId) {
      const settings = getUserSettings()
      const matchingTab = settings.findTabBySession(searchSessionId)
      if (matchingTab) {
        if (settings.activeTabId !== matchingTab.id) {
          settings.setActiveTab(matchingTab.id)
        }
      } else {
        // Session has no tab. Sessions collection is seeded from localStorage
        // on module load, so data is available synchronously on first render.
        const session = sessions.find((s) => s.id === searchSessionId)
        const project = session?.project || 'unknown'
        const title = session?.title || getPreviewText(session ?? { prompt: undefined }) || project
        settings.addTab(project, searchSessionId, title)
      }
    }

    if (searchSessionId && searchSessionId !== selectedSessionId) {
      // URL has a session that doesn't match local state — sync from URL.
      // Skip if a quickPromptHint was just set (tab context-menu action):
      // navigate({ to: '/' }) may not update searchSessionId synchronously,
      // so the stale URL param can race with the freshly-set hint and clear it.
      if (!quickPromptHint) {
        setSpawnConfig(null)
        setQuickPromptHint(null)
        setSelectedSessionId(searchSessionId)
      }
    } else if (!searchSessionId && selectedSessionId && prev !== null) {
      // Navigated from a session URL to "/" (e.g. "New session" click) — clear selection.
      // Skips cold launch where prev is also null (restore case).
      setSpawnConfig(null)
      setSelectedSessionId(null)
    }
  }, [searchSessionId, selectedSessionId, quickPromptHint, sessions])
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
        const promptText =
          typeof config.prompt === 'string'
            ? config.prompt
            : (config.prompt.find((b) => b.type === 'text')?.text ?? '')
        const title = promptText.slice(0, 40) || config.project

        // Set spawn config for auto-spawn in AgentDetailWithSpawn
        setSpawnConfig({
          project: config.project,
          prompt: config.prompt,
          model: config.model,
          agent: config.agent,
        })
        setQuickPromptHint(null)
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
    setQuickPromptHint(null)
    setSelectedSessionId(null)
    navigate({ to: '/' })
  }, [navigate])

  const handleNewSessionInTab = useCallback(
    (project: string) => {
      setSpawnConfig(null)
      setSelectedSessionId(null)
      setQuickPromptHint({ project, newTab: false })
      navigate({ to: '/' })
    },
    [navigate],
  )

  const handleNewTabForProject = useCallback(
    (project: string) => {
      setSpawnConfig(null)
      setSelectedSessionId(null)
      setQuickPromptHint({ project, newTab: true })
      navigate({ to: '/' })
    },
    [navigate],
  )

  const handleStateChange = useCallback(
    (sessionId: string, patch: Record<string, unknown>) => {
      updateSession(sessionId, patch)
    },
    [updateSession],
  )

  const { swipeProps, swipeDir } = useSwipeTabs(handleSelectSession, selectedSessionId)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey

      // Cmd+T: add current session as tab (or no-op)
      if (isMod && e.key === 't') {
        e.preventDefault()
        if (selectedSessionId) {
          const session = sessions.find((s) => s.id === selectedSessionId)
          const project = session?.project || 'unknown'
          getUserSettings().addTab(project, selectedSessionId)
        }
      }

      // Cmd+W: close current tab
      if (isMod && e.key === 'w') {
        e.preventDefault()
        const settings = getUserSettings()
        if (settings.activeTabId) {
          settings.removeTab(settings.activeTabId)
          if (settings.tabs.length <= 1) {
            handleLastTabClosed()
          }
        }
      }

      // Cmd+1-9: switch to Nth tab
      if (isMod && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1
        const settings = getUserSettings()
        if (idx < settings.tabs.length) {
          e.preventDefault()
          const tab = settings.tabs[idx]
          settings.setActiveTab(tab.id)
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
        <PwaInstallBanner />
        <PushOptInBanner />
        <TabBar
          activeSessionId={selectedSessionId}
          onSelectSession={handleSelectSession}
          onLastTabClosed={handleLastTabClosed}
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
          {selectedSessionId ? (
            <AgentDetailWithSpawn
              key={selectedSessionId}
              sessionId={selectedSessionId}
              spawnConfig={spawnConfig}
              onStateChange={handleStateChange}
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
      // Update tab title when session gets a summary, and backfill the
      // project field if it was a placeholder (e.g., "unknown" set when
      // a URL-delivered session had no local metadata yet).
      const title = agent.state.summary || agent.state.project
      const settings = getUserSettings()
      const tab = settings.findTabBySession(sessionId)
      if (tab) {
        if (title && tab.title !== title) {
          settings.updateTabTitle(tab.id, title)
        }
        if (agent.state.project && tab.project !== agent.state.project) {
          settings.updateTabProject(tab.id, agent.state.project)
        }
      }
    }
  }, [agent.state, sessionId, onStateChange])

  return <AgentDetailView name={sessionId} agent={agent} />
}
