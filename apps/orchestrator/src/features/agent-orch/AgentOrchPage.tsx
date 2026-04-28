/**
 * AgentOrchPage — Main page for spawning and observing sessions.
 *
 * Layout: tab bar + main area (selected agent detail view or quick prompt).
 * Tab state is D1-backed via useTabSync (userTabsCollection) — one-tab-per-
 * project is enforced inside the hook, so callers just pass `project` when
 * opening tabs.
 */

import type { SessionSummary } from '@duraclaw/shared-types'
import { createTransaction } from '@tanstack/db'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { PushOptInBanner } from '~/components/push-opt-in-banner'
import { PwaInstallBanner } from '~/components/pwa-install-banner'
import { QuickPromptInput } from '~/components/quick-prompt-input'
import { TabBar } from '~/components/tab-bar'
import { sessionsCollection } from '~/db/sessions-collection'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { useSwipeTabs } from '~/hooks/use-swipe-tabs'
import { getTabSyncSnapshot, isDraftTabId, useTabSync } from '~/hooks/use-tab-sync'
import { useUserDefaults } from '~/hooks/use-user-defaults'
import { consumePendingDeepLink, subscribeDeepLink } from '~/lib/native-push-deep-link'
import { apiUrl } from '~/lib/platform'
import { promptToPreviewText } from '~/lib/prompt-preview'
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
    openTab,
    replaceTab,
    closeTab,
    setActive,
    reorder,
  } = useTabSync()

  // Deep-link: URL has ?session=X → open & activate that tab.
  // If it's already in the Y.Map, just activates it. If the session
  // is in the local `sessions` collection, opens its tab. Otherwise
  // (cache miss — push from another device, fresh session, not yet
  // hydrated) fetches the session row from the API so we can still
  // open the tab. Without that fetch, deep-linked taps to unknown
  // sessions silently no-op.
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
      openTab(searchSessionId, { project: session.project })
      return
    }
    // Cache miss — fetch the session row so we can open its tab.
    // GET /api/sessions/:id returns { session: { project, ... } }.
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(searchSessionId)}`), {
          credentials: 'include',
        })
        if (!resp.ok || cancelled) return
        const body = (await resp.json()) as { session?: { project?: string } } | null
        if (cancelled) return
        const project = body?.session?.project
        if (project) {
          deepLinkedRef.current = searchSessionId
          openTab(searchSessionId, { project })
        }
      } catch {
        // best-effort hydration; swallow network errors
      }
    })()
    return () => {
      cancelled = true
    }
  }, [searchSessionId, openTab, setActive, sessions, openTabs])

  // Native push tap deep-link: handles two delivery windows.
  //   1. Cold-start — the @capacitor/push-notifications listener
  //      stashed the target session id in a module-level pending slot
  //      before React mounted. Consume it on first effect run so the
  //      deep-link wins the race against "restore last-active tab".
  //   2. Warm / post-mount — taps that arrive after first commit are
  //      delivered live via `subscribeDeepLink`. Without this, the
  //      one-shot consume would miss them and the user would land on
  //      whatever tab was last active.
  const coldStartedRef = useRef(false)
  const deepLinkConsumedRef = useRef(false)
  useEffect(() => {
    // Cold-start consume (one-shot for first mount).
    if (!deepLinkConsumedRef.current) {
      deepLinkConsumedRef.current = true
      const pending = consumePendingDeepLink()
      if (pending && !searchSessionId) {
        // Block cold-start so it doesn't also navigate.
        coldStartedRef.current = true
        navigate({ to: '/', search: { session: pending }, replace: true })
      }
    }
    // Live subscriber for post-mount taps.
    const unsub = subscribeDeepLink((sessionId) => {
      coldStartedRef.current = true
      navigate({ to: '/', search: { session: sessionId }, replace: true })
    })
    return unsub
  }, [navigate, searchSessionId])

  // Cold-start: page loaded at "/" with no ?session — restore the last
  // active tab from localStorage, or fall back to the first open tab.
  // One-shot on mount so a later in-app nav to "/" (e.g. sidebar "New
  // session") isn't bounced back.
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

  // Follow peer-driven activeSessionId changes into the URL. useTabSync's
  // follow effect advances `activeSessionId` when a peer device swaps the
  // session inside the tab the user is viewing; without this watcher the
  // URL would stay pinned to the stale id and the deep-link effect would
  // bounce activeSessionId back. Skip until cold-start has run so we don't
  // race the initial restore. `replace: true` so peer-driven follow
  // doesn't pollute browser history.
  useEffect(() => {
    if (!coldStartedRef.current) return
    if (!activeSessionId) return
    if (activeSessionId === searchSessionId) return
    navigate({ to: '/', search: { session: activeSessionId }, replace: true })
  }, [activeSessionId, searchSessionId, navigate])

  const [spawnConfig, setSpawnConfig] = useState<
    (SpawnConfig & { targetSessionId?: string }) | null
  >(null)
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
        targetSessionId: clientSessionId,
      })
      setQuickPromptHint(null)

      // The sidebar "+ New session" button still seeds a draft tab id
      // (sess-uuid is reserved for direct-create). Submitting a prompt from
      // its QuickPromptInput swaps the draft id for the real session id in
      // place — without `replaceTab`, the draft tab would linger alongside
      // the new real one.
      const activeDraft = isDraftTabId(activeSessionId) ? activeSessionId : null
      if (activeDraft) {
        replaceTab(
          activeDraft,
          clientSessionId,
          config.newTab ? undefined : { dedupProject: config.project },
        )
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

  // Default model + agent for direct-create new sessions. Falls back to
  // user preferences when available so the click-through matches whatever
  // the user normally chooses.
  const { preferences } = useUserDefaults()

  // Direct-create a real session for a project — no draft tab, no form.
  // We mint a client-side session id, optimistic-insert the row into
  // sessionsCollection, and POST /api/sessions with no prompt. The DO
  // initializes in `idle`; the runner is dialled lazily on the first
  // sendMessage. Phantom sessions (no first message ever sent) sit at
  // status='idle' indefinitely and cost nothing — that's the point.
  const directCreateSession = useCallback(
    (project: string, opts: { newTab: boolean }) => {
      const clientSessionId = `sess-${crypto.randomUUID()}`
      const now = new Date().toISOString()
      const model =
        NEW_SESSION_MODEL_OPTIONS.find((m) => m.value === preferences.model)?.value ??
        NEW_SESSION_MODEL_OPTIONS[0].value
      const agent = NEW_SESSION_MODEL_OPTIONS.find((m) => m.value === model)?.agent ?? 'claude'

      const optimisticRow: SessionSummary = {
        id: clientSessionId,
        userId: null,
        project,
        status: 'idle',
        model,
        prompt: '',
        agent,
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
              project,
              model,
              agent,
              // No prompt — DO routes to initialize() and sits idle until
              // the first sendMessage triggers the fresh-execute fallback.
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

      // Don't set spawnConfig — there's no prompt to spawn with. The
      // AgentDetailWithSpawn auto-spawn is gated on spawnConfig being
      // set, so it stays dormant. The first user keystroke goes through
      // sendMessage which the DO routes to the fresh-execute fallback.
      setSpawnConfig(null)
      setQuickPromptHint(null)

      openTab(clientSessionId, { project, forceNewTab: opts.newTab })
      navigate({ to: '/', search: { session: clientSessionId } })

      tx.isPersisted.promise.catch((err) => {
        console.error('[AgentOrch] Direct-create session failed:', err)
      })
    },
    [navigate, openTab, preferences.model],
  )

  const handleNewSessionInTab = useCallback(
    (project: string) => {
      directCreateSession(project, { newTab: false })
    },
    [directCreateSession],
  )

  const handleNewTabForProject = useCallback(
    (project: string) => {
      directCreateSession(project, { newTab: true })
    },
    [directCreateSession],
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
      <Header fixed flush>
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
      </Header>
      <Main fixed fluid className="p-0" {...swipeProps}>
        <PwaInstallBanner />
        <PushOptInBanner />
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
  spawnConfig: (SpawnConfig & { targetSessionId?: string }) | null
}) {
  const agent = useCodingAgent(sessionId)
  const spawnedRef = useRef(false)

  useEffect(() => {
    // Spec #31 P5 B10: `agent.state` is gone. Gate on the WS being OPEN
    // (readyState === 1) instead — semantically this matches the old
    // "initial state delivered" trigger since the state push immediately
    // followed connection establishment.
    //
    // Guard: only spawn if this component's sessionId matches the
    // spawnConfig's targetSessionId. Prevents a cross-session data leak
    // where a stale spawnConfig could fire spawn() on the wrong DO
    // during a tab-switch race (GH#75).
    if (
      spawnConfig &&
      (!spawnConfig.targetSessionId || spawnConfig.targetSessionId === sessionId) &&
      agent.wsReadyState === 1 &&
      !spawnedRef.current
    ) {
      spawnedRef.current = true
      agent.spawn(spawnConfig).catch((err: unknown) => {
        console.error('[AgentOrch] Spawn failed:', err)
      })
    }
  }, [spawnConfig, sessionId, agent.wsReadyState, agent.spawn])

  return <AgentDetailView name={sessionId} agent={agent} />
}

const NEW_SESSION_MODEL_OPTIONS = [
  { value: 'claude-opus-4-7', label: 'claude-opus-4-7', agent: 'claude' },
  { value: 'claude-opus-4-6', label: 'claude-opus-4-6', agent: 'claude' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', agent: 'claude' },
  { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5', agent: 'claude' },
  { value: 'gpt-5.4', label: 'codex — gpt-5.4', agent: 'codex' },
  { value: 'gpt-5.4-mini', label: 'codex — gpt-5.4-mini', agent: 'codex' },
]
