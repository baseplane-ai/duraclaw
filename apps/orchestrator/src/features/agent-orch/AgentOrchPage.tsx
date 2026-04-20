/**
 * AgentOrchPage — Main page for spawning and observing sessions.
 *
 * Layout: tab bar + main area (selected agent detail view or quick prompt).
 * Tab state is Yjs-backed via useTabSync — one-tab-per-project is enforced
 * inside the hook, so callers just pass `project` when opening tabs.
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
import { getTabSyncSnapshot, isDraftTabId, newDraftTabId, useTabSync } from '~/hooks/use-tab-sync'
import { apiUrl } from '~/lib/platform'
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

  const {
    openTabs,
    activeSessionId,
    tabProjects,
    hydrated,
    openTab,
    closeTab,
    replaceTab,
    setActive,
    reorder,
  } = useTabSync()

  // Deep-link: URL has ?session=X → open & activate that tab.
  // Only creates a tab if the session exists in the collection (has a
  // project). If it's already in the Y.Map, just activates it. If
  // sessions haven't loaded yet, waits — the effect re-runs when they do.
  const deepLinkedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!searchSessionId || searchSessionId === deepLinkedRef.current) return
    // Already in tabs? Just activate, no validation needed.
    if (openTabs.includes(searchSessionId)) {
      deepLinkedRef.current = searchSessionId
      setActive(searchSessionId)
      return
    }
    // Not in tabs — only create if session is known (has project).
    const session = sessions.find((s) => s.id === searchSessionId)
    if (session?.project) {
      deepLinkedRef.current = searchSessionId
      if (session?.kataIssue != null) {
        openTab(`chain:${session.kataIssue}`, {
          kind: 'chain',
          issueNumber: session.kataIssue,
        })
      }
      openTab(searchSessionId, { project: session.project })
    }
    // If sessions haven't loaded yet, this is a no-op. The effect
    // re-runs when `sessions` changes and picks it up then.
  }, [searchSessionId, openTab, setActive, sessions, openTabs])

  // Cold-start: page loaded at "/" with no ?session, but localStorage
  // has a remembered active tab — restore it in the URL (one-shot).
  const coldStartedRef = useRef(false)
  useEffect(() => {
    if (coldStartedRef.current || searchSessionId) return
    if (activeSessionId) {
      coldStartedRef.current = true
      navigate({ to: '/', search: { session: activeSessionId }, replace: true })
    }
  }, [activeSessionId, navigate, searchSessionId])

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
    fetch(apiUrl('/api/gateway/projects'))
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
        // TODO: wire worktree checkout here when AgentOrchPage learns
        // kataIssue from the spawn form. Chain-scoped code-touching spawns
        // from the kanban go through advance-chain.ts which handles this;
        // freeform spawns from this form currently bypass the gate.
        const resp = await fetch(apiUrl('/api/sessions'), {
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

        // If a draft tab is active, hydrate it in place (keep its slot);
        // otherwise fall back to the original open-a-tab behavior.
        const activeDraft = isDraftTabId(activeSessionId) ? activeSessionId : null
        if (activeDraft) {
          replaceTab(activeDraft, sessionId)
        } else {
          const session = sessions.find((s) => s.id === sessionId)
          if (session?.kataIssue != null) {
            openTab(`chain:${session.kataIssue}`, {
              kind: 'chain',
              issueNumber: session.kataIssue,
            })
          }
          openTab(sessionId, { project: config.project, forceNewTab: config.newTab })
        }
        navigate({ to: '/', search: { session: sessionId } })
      } catch (err) {
        console.error('[AgentOrch] Spawn failed:', err)
      }
    },
    [navigate, openTab, replaceTab, activeSessionId, sessions],
  )

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (session?.kataIssue != null) {
        openTab(`chain:${session.kataIssue}`, {
          kind: 'chain',
          issueNumber: session.kataIssue,
        })
      }
      openTab(sessionId, { project: session?.project })
      setSpawnConfig(null)
      navigate({ to: '/', search: { session: sessionId } })
    },
    [navigate, openTab, sessions],
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
      setQuickPromptHint({ project, newTab: false })
      // Drop the current project's tab and open an active draft tab in
      // its place. The composer renders inside this tab's content slot;
      // on first send, handleSpawn swaps the draft id for the real one.
      const draftId = newDraftTabId()
      openTab(draftId, { project, forceNewTab: false })
      navigate({ to: '/', search: { session: draftId } })
    },
    [navigate, openTab],
  )

  const handleNewTabForProject = useCallback(
    (project: string) => {
      setSpawnConfig(null)
      setQuickPromptHint({ project, newTab: true })
      // Open a draft tab alongside any existing tab for this project.
      const draftId = newDraftTabId()
      openTab(draftId, { project, forceNewTab: true })
      navigate({ to: '/', search: { session: draftId } })
    },
    [navigate, openTab],
  )

  const { swipeProps, swipeDir } = useSwipeTabs(handleSelectSession, activeSessionId)

  // ── Keyboard shortcuts ───────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey

      if (isMod && e.key === 't') {
        e.preventDefault()
      }

      if (isMod && e.key === 'w') {
        e.preventDefault()
        const { activeSessionId: active } = getTabSyncSnapshot()
        if (active) handleCloseTab(active)
      }

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
        {hydrated && (
          <TabBar
            openTabs={openTabs}
            activeSessionId={activeSessionId}
            tabProjects={tabProjects}
            onSelectSession={handleSelectSession}
            onCloseTab={handleCloseTab}
            onReorder={reorder}
            onNewSessionInTab={handleNewSessionInTab}
            onNewTabForProject={handleNewTabForProject}
          />
        )}
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
          {activeSessionId && !isDraftTabId(activeSessionId) ? (
            <AgentDetailWithSpawn
              key={activeSessionId}
              sessionId={activeSessionId}
              spawnConfig={spawnConfig}
            />
          ) : (
            <QuickPromptInput
              key={
                activeSessionId && isDraftTabId(activeSessionId)
                  ? `draft-${activeSessionId}`
                  : quickPromptHint
                    ? `hint-${quickPromptHint.project}-${quickPromptHint.newTab}`
                    : 'default'
              }
              onSubmit={handleSpawn}
              projects={projects}
              projectsLoading={projectsLoading}
              initialProject={
                activeSessionId && isDraftTabId(activeSessionId)
                  ? tabProjects[activeSessionId]
                  : quickPromptHint?.project
              }
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
