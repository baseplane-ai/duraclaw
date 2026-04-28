/**
 * AgentDetailView — Live status display for a single SessionDO instance.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useEffect, useMemo } from 'react'
import { ApiRetryBanner } from '~/components/api-retry-banner'
import { DisconnectedBanner } from '~/components/disconnected-banner'
import { StatusBar } from '~/components/status-bar'
import { VisibilityBadge } from '~/components/visibility-badge'
import { type BranchInfoRow, createBranchInfoCollection } from '~/db/branch-info-collection'
import { projectsCollection } from '~/db/projects-collection'
import { useSessionStatus } from '~/db/session-local-collection'
import { useDerivedGate } from '~/hooks/use-derived-gate'
import { useSession } from '~/hooks/use-sessions-collection'
import { useSession as useAuthSession } from '~/lib/auth-client'
import { apiUrl } from '~/lib/platform'
import type { SessionStatus } from '~/lib/types'
import { useStatusBarStore } from '~/stores/status-bar'
import { ChatThread } from './ChatThread'
import { MessageInput } from './MessageInput'
import type { UseCodingAgentResult } from './use-coding-agent'

interface AgentDetailViewProps {
  name: string
  agent: UseCodingAgentResult
}

// GH#55: shared empty-map singleton reused for any session with no branch
// rows. Having a stable reference here keeps ChatThread's `itemContent`
// closure identity stable across WS re-emits on mount. Typed as `Map` (not
// `ReadonlyMap`) so it satisfies ChatThread's `branchInfo?: Map<...>` prop;
// we never write to it.
const EMPTY_BRANCH_INFO = new Map<string, { current: number; total: number; siblings: string[] }>()

export function AgentDetailView({ name: sessionId, agent }: AgentDetailViewProps) {
  const {
    messages,
    isConnecting,
    stop,
    interrupt,
    forceStop,
    resolveGate,
    sendMessage,
    submitDraft,
    rewind,
    navigateBranch,
    reattach,
    resumeFromTranscript,
  } = agent

  // Spec #37 P2b: read the D1-mirrored session row for status / project /
  // model / runnerSessionId. DO is authoritative — no client-side writes.
  const session = useSession(sessionId)

  // GH#14 B7: derive a Map<parentMsgId, {current,total,siblings}> from the
  // per-session `branchInfoCollection` (DO-authored). ChatThread accepts the
  // Map shape so upstream tests stay unchanged; the Map is rebuilt from the
  // collection on every reactive update.
  const branchInfoCollection = useMemo(() => createBranchInfoCollection(sessionId), [sessionId])
  const { data: branchInfoRows } = useLiveQuery(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q) => q.from({ rows: branchInfoCollection as any }),
    [branchInfoCollection],
  )
  const branchInfo = useMemo(() => {
    // GH#55: reuse the shared empty-map singleton when there are no branch
    // rows for this session. `useLiveQuery` re-emits (with the same empty
    // dataset) on the WS-snapshot burst right after mount, which would
    // otherwise produce a fresh Map each time — destabilising ChatThread's
    // `itemContent` closure (branchInfo is in its deps) and forcing
    // Virtuoso to re-invoke itemContent for every visible row on a heavy
    // session switch.
    if (!branchInfoRows || branchInfoRows.length === 0) return EMPTY_BRANCH_INFO
    const map = new Map<string, { current: number; total: number; siblings: string[] }>()
    for (const row of branchInfoRows as unknown as BranchInfoRow[]) {
      const idx = row.siblings.indexOf(row.activeId)
      // Key the map on `activeId` (the user-message id the UI is currently
      // rendering under `msg.id`), matching the pre-B7 client contract.
      map.set(row.activeId, {
        current: idx >= 0 ? idx + 1 : 1,
        total: row.siblings.length,
        siblings: row.siblings,
      })
    }
    return map
  }, [branchInfoRows])

  // Only onStop / onInterrupt remain in the Zustand store — they're
  // consumed by the composer footer action buttons, not by StatusBar.
  const statusBarSet = useStatusBarStore((s) => s.set)
  const statusBarClear = useStatusBarStore((s) => s.clear)

  useEffect(() => {
    statusBarSet({ onStop: stop, onInterrupt: interrupt })
  }, [stop, interrupt, statusBarSet])

  useEffect(() => {
    return () => statusBarClear()
  }, [statusBarClear])

  // GH#115 P1.4: the legacy `worktreeInfoJson` mirror was dropped (it
  // was never wired). Branch/PR display reads from `projectsCollection`
  // (synced from the gateway with live git state). The live query is
  // kept here so any future `matchedProject` dependants stay wired
  // without a client-side upsert path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useLiveQuery((q) => q.from({ p: projectsCollection as any }))

  const handleSendSuggestion = useCallback(
    (text: string) => {
      sendMessage(text)
    },
    [sendMessage],
  )

  // On mobile (Capacitor SQLite) the messages collection hydrates async,
  // so `messages.length === 0` briefly holds even for sessions with prior
  // turns — without this hint, ChatThread would flash the
  // "Start a conversation" suggestion chips before the cached transcript
  // paints. `numTurns` comes from the D1-mirrored sessions row, which
  // hydrates synchronously from the synced collection.
  const expectsMessages = (session?.numTurns ?? 0) > 0

  const status =
    useSessionStatus(sessionId) ?? (session?.status as SessionStatus | undefined) ?? 'idle'

  // GH (force-stop fix): the Stop button must remain reachable when a gate
  // part is pending in messages even if `status` has flipped to `idle` —
  // e.g. wedged-from-idle, where the runner died but `tool-AskUserQuestion`
  // is still sitting `input-available`. `useDerivedGate` covers all three
  // gate-part shapes (legacy + SDK-native), so coercing its truthy result
  // into a boolean is enough to keep the composer in "interruptible" mode.
  const hasPendingGate = Boolean(useDerivedGate(sessionId))

  // Draft key scopes localStorage drafts. Tabs ARE sessions (userTabsCollection
  // rows keyed by sessionId), so use sessionId directly — no separate tab ID.
  const draftKey = sessionId

  // Spec #68 B12: visibility badge + admin-only toggle.
  const { data: authSession } = useAuthSession()
  const role = (authSession as { user?: { role?: string } } | null)?.user?.role ?? 'user'
  const isAdmin = role === 'admin'
  const visibility = session?.visibility
  const handleToggleVisibility = useCallback(async () => {
    if (!visibility) return
    const next = visibility === 'public' ? 'private' : 'public'
    if (next === 'public') {
      const confirmed = window.confirm('Make this session visible to all users?')
      if (!confirmed) return
    }
    try {
      const resp = await fetch(apiUrl(`/api/sessions/${sessionId}/visibility`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ visibility: next }),
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        window.alert(`Failed to update visibility (${resp.status}): ${body}`)
      }
    } catch (err) {
      window.alert(
        `Failed to update visibility: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // Synced-collection delta brings the row up to date — no manual refresh.
  }, [sessionId, visibility])

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
      data-testid="agent-detail-view"
    >
      <ChatThread
        sessionId={sessionId}
        messages={messages}
        isConnecting={isConnecting}
        onResolveGate={resolveGate}
        onRewind={rewind}
        branchInfo={branchInfo}
        onBranchNavigate={navigateBranch}
        onSendSuggestion={handleSendSuggestion}
        expectsMessages={expectsMessages}
      />

      <ApiRetryBanner />
      <DisconnectedBanner
        sessionId={sessionId}
        onReattach={reattach}
        onResumeFromTranscript={resumeFromTranscript}
      />
      {visibility && (
        <div className="flex items-center gap-2 px-3 py-1 text-[10px]">
          <VisibilityBadge visibility={visibility} showLabel />
          {isAdmin && (
            <button
              type="button"
              onClick={handleToggleVisibility}
              className="text-[10px] text-muted-foreground underline hover:text-foreground"
            >
              Make {visibility === 'public' ? 'private' : 'public'}
            </button>
          )}
        </div>
      )}
      <StatusBar sessionId={sessionId} />
      <MessageInput
        onSend={sendMessage}
        submitDraft={submitDraft}
        sessionId={sessionId}
        // Composer stays active during `waiting_gate` — sending a message
        // while an ask_user gate is pending auto-declines the gate
        // (see use-coding-agent's sendMessage / submitDraft: they call
        // `declinePendingAskUserGate()` before the send). Input is never
        // gate-disabled; interrupt remains available via the status check
        // inside MessageInput.
        disabled={false}
        status={status}
        hasPendingGate={hasPendingGate}
        onInterrupt={interrupt}
        onForceStop={forceStop}
        draftKey={draftKey}
      />
    </div>
  )
}
