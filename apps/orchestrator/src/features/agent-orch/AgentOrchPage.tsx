/**
 * AgentOrchPage — Main page for spawning and observing sessions.
 *
 * Layout: tab bar + main area (selected agent detail view or quick prompt).
 * Tab state is Yjs-backed via useTabSync — one-tab-per-project is enforced
 * inside the hook, so callers just pass `project` when opening tabs.
 */

import type { SessionSummary } from '@duraclaw/shared-types'
import { createTransaction } from '@tanstack/db'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { PushOptInBanner } from '~/components/push-opt-in-banner'
import { PwaInstallBanner } from '~/components/pwa-install-banner'
import { QuickPromptInput } from '~/components/quick-prompt-input'
import { StatusBar } from '~/components/status-bar'
import { TabBar } from '~/components/tab-bar'
import { sessionsCollection } from '~/db/sessions-collection'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { useSwipeTabs } from '~/hooks/use-swipe-tabs'
import { getTabSyncSnapshot, isDraftTabId, newDraftTabId, useTabSync } from '~/hooks/use-tab-sync'
import { useUserDefaults } from '~/hooks/use-user-defaults'
import { apiUrl } from '~/lib/platform'
import { promptToPreviewText } from '~/lib/prompt-preview'
import type { ContentBlock } from '~/lib/types'
import { AgentDetailView } from './AgentDetailView'
import { ChatThread } from './ChatThread'
import { MessageInput } from './MessageInput'
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

  // Cold-start: page loaded at "/" with no ?session — restore the last
  // active tab from localStorage, or fall back to the first open tab.
  // One-shot on mount so a later in-app nav to "/" (e.g. sidebar "New
  // session") isn't bounced back.
  const coldStartedRef = useRef(false)
  useEffect(() => {
    if (coldStartedRef.current) return
    if (searchSessionId) {
      coldStartedRef.current = true
      return
    }
    const target = activeSessionId ?? openTabs[0]
    if (target) {
      coldStartedRef.current = true
      setActive(target)
      navigate({ to: '/', search: { session: target }, replace: true })
    }
  }, [activeSessionId, openTabs, setActive, navigate, searchSessionId])

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
    (config: SpawnFormConfig & { newTab?: boolean }) => {
      // Optimistic-create path: the UI swaps to AgentDetailView immediately
      // with a client-minted session id, and POST /api/sessions fires in the
      // background. The server binds the DO via `idFromName(clientSessionId)`
      // and echoes the D1 row via broadcastSessionRow — which reconciles our
      // optimistic overlay by deep-equals. WS orderings are safe: if it
      // opens before `/create` completes, onConnect replays empty history
      // and the spawn-triggered broadcast later delivers the user message;
      // the second `agent.spawn()` call from AgentDetailWithSpawn is
      // idempotent (SessionDO returns 'Session already active').
      const clientSessionId = `sess-${crypto.randomUUID()}`
      const now = new Date().toISOString()
      // Reduce a ContentBlock[] (e.g. image-paste spawn) to a readable
      // preview string — otherwise the full JSON blob (including base64
      // image payloads) leaks through as the session's displayed title
      // via the `session.title || summary || prompt` fallback chain.
      const promptText = promptToPreviewText(config.prompt)

      const optimisticRow: SessionSummary = {
        id: clientSessionId,
        userId: null,
        project: config.project,
        status: 'running',
        model: config.model ?? null,
        prompt: promptText,
        agent: config.agent ?? 'claude',
        origin: 'duraclaw',
        createdAt: now,
        updatedAt: now,
        lastActivity: now,
        archived: false,
      }

      const tx = createTransaction({
        mutationFn: async () => {
          const resp = await fetch(apiUrl('/api/sessions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              client_session_id: clientSessionId,
              project: config.project,
              prompt: config.prompt,
              model: config.model,
              agent: config.agent,
            }),
          })
          if (!resp.ok) {
            throw new Error(`Failed to create session: ${resp.status}`)
          }
        },
      })

      const coll = sessionsCollection as unknown as {
        insert: (row: SessionSummary) => void
        has: (key: string) => boolean
      }
      tx.mutate(() => {
        if (!coll.has(clientSessionId)) coll.insert(optimisticRow)
      })

      setSpawnConfig({
        project: config.project,
        prompt: config.prompt,
        model: config.model,
        agent: config.agent,
      })
      setQuickPromptHint(null)

      const activeDraft = isDraftTabId(activeSessionId) ? activeSessionId : null
      if (activeDraft) {
        replaceTab(activeDraft, clientSessionId)
      } else {
        openTab(clientSessionId, { project: config.project, forceNewTab: config.newTab })
      }
      navigate({ to: '/', search: { session: clientSessionId } })

      // Surface POST failures without blocking UI. If the server rejects the
      // create, the optimistic row rolls back via the tx; the user is left
      // on an orphaned tab until they close it — acceptable for a rare path.
      tx.isPersisted.promise.catch((err) => {
        console.error('[AgentOrch] Spawn failed:', err)
      })
    },
    [navigate, openTab, replaceTab, activeSessionId],
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
          ) : activeSessionId && isDraftTabId(activeSessionId) && tabProjects[activeSessionId] ? (
            <DraftDetailView
              key={`draft-${activeSessionId}`}
              draftId={activeSessionId}
              project={tabProjects[activeSessionId]}
              onSpawn={handleSpawn}
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
    // Spec #31 P5 B10: `agent.state` is gone. Gate on the WS being OPEN
    // (readyState === 1) instead — semantically this matches the old
    // "initial state delivered" trigger since the state push immediately
    // followed connection establishment.
    if (spawnConfig && agent.wsReadyState === 1 && !spawnedRef.current) {
      spawnedRef.current = true
      agent.spawn(spawnConfig).catch((err: unknown) => {
        console.error('[AgentOrch] Spawn failed:', err)
      })
    }
  }, [spawnConfig, agent.wsReadyState, agent.spawn])

  return <AgentDetailView name={sessionId} agent={agent} />
}

/**
 * Pre-spawn view rendered into a draft tab. Mirrors AgentDetailView's layout
 * (empty ChatThread + StatusBar + MessageInput) so the user lands in a blank
 * chat rather than the centered picker form. On first send, `handleSpawn`
 * replaces the draft tab id with the real session id and the regular
 * AgentDetailWithSpawn takes over.
 */
function DraftDetailView({
  draftId,
  project,
  onSpawn,
}: {
  draftId: string
  project: string
  onSpawn: (config: SpawnFormConfig & { newTab?: boolean }) => void
}) {
  const { preferences } = useUserDefaults()

  const handleSend = useCallback(
    (content: string | ContentBlock[]) => {
      const model = preferences.model ?? 'claude-opus-4-7'
      const agent = model.startsWith('gpt-') ? 'codex' : 'claude'
      onSpawn({ project, model, agent, prompt: content })
    },
    [project, preferences.model, onSpawn],
  )

  const branchInfo = useMemo(
    () => new Map<string, { current: number; total: number; siblings: string[] }>(),
    [],
  )

  const noopResolveGate = useCallback(async () => undefined, [])

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
      data-testid="draft-detail-view"
    >
      <ChatThread
        messages={[]}
        derivedGate={null}
        isConnecting={false}
        onResolveGate={noopResolveGate}
        branchInfo={branchInfo}
        onSendSuggestion={handleSend}
      />
      <StatusBar sessionId={null} />
      <MessageInput onSend={handleSend} draftKey={draftId} />
    </div>
  )
}
