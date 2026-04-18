/**
 * AgentOrchPage — Main page for spawning and observing sessions.
 *
 * Layout: sidebar (session list + spawn form) + main area (selected agent detail view).
 * Adapted from baseplane: session metadata is read from D1 via the
 * sessions collection, with duraclaw's TanStack Router and SessionDO.
 */

import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { PushOptInBanner } from '~/components/push-opt-in-banner'
import { PwaInstallBanner } from '~/components/pwa-install-banner'
import { QuickPromptInput } from '~/components/quick-prompt-input'
import { TabBar } from '~/components/tab-bar'
import { userTabsCollection } from '~/db/user-tabs-collection'
import { getActiveTabId, setActiveTabId } from '~/hooks/use-active-tab'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { useSwipeTabs } from '~/hooks/use-swipe-tabs'
import { ensureTabForSession, newTabId, nextPosition } from '~/lib/tab-utils'
import type { UserTabRow } from '~/lib/types'
import { AgentDetailView } from './AgentDetailView'
import type { SpawnFormConfig } from './SpawnAgentForm'
import { type SpawnConfig, useCodingAgent } from './use-coding-agent'

export function AgentOrchPage() {
  return <AgentOrchContent />
}

// ── Helpers ───────────────────────────────────────────────────────
// Tab utilities (newTabId, nextPosition, ensureTabForSession) are in
// ~/lib/tab-utils.ts — shared across AgentOrchPage, nav-sessions, and
// notification-drawer to avoid duplicate insert-or-find logic.

function AgentOrchContent() {
  const { updateSession } = useSessionsCollection()
  const search = useSearch({ from: '/_authenticated/' })
  const navigate = useNavigate()
  const searchSessionId = (search as { session?: string }).session ?? null
  const searchNewSessionProject =
    (search as { newSessionProject?: string }).newSessionProject ?? null
  const searchNewTab = (search as { newTab?: boolean }).newTab ?? false

  // Synchronous init: resolve selectedSessionId from URL or last active tab.
  // Tabs live in `userTabsCollection` (D1-synced, OPFS-cached) — `.toArray()`
  // returns the hydrated rows synchronously on cold start. The init effect
  // also seeds an optimistic tab row for URL-delivered sessions so the tab
  // bar renders on the first frame.
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => {
    if (searchSessionId) {
      // Notification deep-link / shared URL: ensure a tab exists for this
      // session id so the tab bar shows it on the very first frame. The tab
      // initially has no joined session row; the join skeleton renders until
      // agentSessionsCollection hydrates.
      ensureTabForSession(searchSessionId)
      return searchSessionId
    }
    // Cold launch fallback: prefer the persisted active tab; else the first tab.
    const tabs = userTabsCollection.toArray as unknown as UserTabRow[]
    const activeId = getActiveTabId()
    if (activeId) {
      const match = tabs.find((t) => t.id === activeId)
      if (match?.sessionId) return match.sessionId
    }
    if (tabs.length > 0) {
      const fallback = tabs[0]
      setActiveTabId(fallback.id)
      return fallback.sessionId ?? null
    }
    return null
  })

  const [spawnConfig, setSpawnConfig] = useState<SpawnConfig | null>(null)
  // Pre-fill hints for the QuickPromptInput composer, set by tab context menu actions.
  // Seed from URL search params so the hint survives reloads / cold launches.
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
        setQuickPromptHint(null)
        setSelectedSessionId(sessionId)

        // Add to tab. With project/title fields gone, "newTab vs replace"
        // collapses: `newTab` always inserts; default uses the find-or-create
        // path so a re-prompt for the same session reuses the existing tab.
        if (config.newTab) {
          const id = newTabId()
          userTabsCollection.insert({
            id,
            userId: '',
            sessionId,
            position: nextPosition(),
            createdAt: new Date().toISOString(),
          } as UserTabRow & Record<string, unknown>)
          setActiveTabId(id)
        } else {
          ensureTabForSession(sessionId)
        }

        navigate({ to: '/', search: { session: sessionId } })
      } catch (err) {
        console.error('[AgentOrch] Spawn failed:', err)
      }
    },
    [navigate],
  )

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      ensureTabForSession(sessionId)
      setSpawnConfig(null)
      setSelectedSessionId(sessionId)
      navigate({ to: '/', search: { session: sessionId } })
    },
    [navigate],
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

  // ── Keyboard shortcuts ───────────────────────────────────────────
  // Reads userTabsCollection / getActiveTabId synchronously inside the handler
  // so the listener never needs to depend on tab state — a single listener
  // registration for the lifetime of the component.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey

      // Cmd+T: ensure a tab exists for the current session (no-op otherwise)
      if (isMod && e.key === 't') {
        e.preventDefault()
        if (selectedSessionId) {
          ensureTabForSession(selectedSessionId)
        }
      }

      // Cmd+W: close active tab
      if (isMod && e.key === 'w') {
        e.preventDefault()
        const activeId = getActiveTabId()
        if (activeId && userTabsCollection.has(activeId)) {
          userTabsCollection.delete([activeId])
          if (userTabsCollection.size <= 1) {
            handleLastTabClosed()
          }
        }
      }

      // Cmd+1-9: switch to Nth tab
      if (isMod && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1
        const tabs = userTabsCollection.toArray as unknown as UserTabRow[]
        const tab = tabs[idx]
        if (tab) {
          e.preventDefault()
          setActiveTabId(tab.id)
          if (tab.sessionId) {
            handleSelectSession(tab.sessionId)
          }
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedSessionId, handleSelectSession, handleLastTabClosed])

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

  // Sync DO state changes to the sessions collection. Tab title/project come
  // from the join with agentSessionsCollection (B-UI-1) — no per-tab title or
  // project fields any more, so this effect just forwards the patch.
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
