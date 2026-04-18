/**
 * Dev-only prototype route: /debug/session-collection?session=<id>
 *
 * Proves R1 from planning/research/2026-04-18-session-tab-loading-trace.md §6:
 * messagesCollection as the sole render source, with useAgent WS writing
 * upserts directly into the collection and useLiveQuery feeding the UI.
 *
 * Isolation contract:
 *   - Zero changes to production hooks / components / collections.
 *   - Same auth-guarded shell as the main app (/_authenticated/).
 *   - Gated behind import.meta.env.DEV — production bundles see a stub.
 *
 * Run the §8.4 verification checklist in this route before promoting R1.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { createFileRoute, useSearch } from '@tanstack/react-router'
import { useMemo } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { agentSessionsCollection } from '~/db/agent-sessions-collection'
import { CollectionMessageView } from '~/features/agent-orch/debug/CollectionMessageView'
import { useCodingAgentCollection } from '~/features/agent-orch/use-coding-agent-collection'

export const Route = createFileRoute('/_authenticated/debug/session-collection')({
  component: DebugSessionCollectionPage,
  validateSearch: (search: Record<string, unknown>): { session?: string } => ({
    session: typeof search.session === 'string' ? search.session : undefined,
  }),
})

function DebugSessionCollectionPage() {
  // Hooks first (rules of hooks); gate on isDev AFTER the hook calls.
  const { session: sessionFromUrl } = useSearch({
    from: '/_authenticated/debug/session-collection',
  })

  // Dev-gate: render a notice in production builds. import.meta.env.DEV is
  // true for vite dev + miniflare local runs and false in wrangler deploy.
  const isDev = ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ?? false) === true

  if (!isDev) {
    return (
      <>
        <Header />
        <Main>
          <div className="p-6 text-sm text-neutral-400">
            This debug route is only available in dev builds.
          </div>
        </Main>
      </>
    )
  }

  return (
    <>
      <Header />
      <Main>
        <div className="flex flex-col h-[calc(100vh-4rem)]">
          <div className="border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
            <strong className="text-neutral-200">R1 prototype</strong> — messagesCollection as
            render source. See planning/research/2026-04-18-session-tab-loading-trace.md §8.
          </div>
          {sessionFromUrl ? <SessionPane sessionId={sessionFromUrl} /> : <SessionPicker />}
        </div>
      </Main>
    </>
  )
}

function SessionPane({ sessionId }: { sessionId: string }) {
  const { state, messages, isHydrated, isConnecting, sendMessage } =
    useCodingAgentCollection(sessionId)

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-4 py-1 text-[11px] text-neutral-500 font-mono">
        state.status: {state?.status ?? '(null)'} · sdk_session_id:{' '}
        {state?.sdk_session_id ?? '(none)'}
      </div>
      <div className="flex-1 min-h-0">
        <CollectionMessageView
          sessionId={sessionId}
          messages={messages}
          isHydrated={isHydrated}
          isConnecting={isConnecting}
          onSend={(text) => sendMessage(text)}
        />
      </div>
    </div>
  )
}

function SessionPicker() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery((q) => q.from({ s: agentSessionsCollection as any }))

  const rows = useMemo(() => {
    if (!data) return []
    return (data as Array<{ id: string; project?: string; status?: string; title?: string }>)
      .slice()
      .sort((a, b) => (a.id < b.id ? 1 : -1))
  }, [data])

  return (
    <div className="p-4 overflow-y-auto">
      <div className="text-sm text-neutral-300 mb-2">
        Pick a session to probe (appends <code>?session=&lt;id&gt;</code>):
      </div>
      <ul className="space-y-1 font-mono text-sm">
        {rows.length === 0 && (
          <li className="text-neutral-500 italic">
            (no sessions — open one in the main app first, then return here)
          </li>
        )}
        {rows.map((r) => (
          <li key={r.id}>
            <a
              href={`/debug/session-collection?session=${encodeURIComponent(r.id)}`}
              className="text-blue-400 hover:underline"
            >
              {r.id}
            </a>
            <span className="text-neutral-500">
              {' '}
              — {r.project ?? '(no project)'} · {r.status ?? '(no status)'}
              {r.title ? ` · ${r.title}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
