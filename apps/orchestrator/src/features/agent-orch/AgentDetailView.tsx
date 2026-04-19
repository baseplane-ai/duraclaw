/**
 * AgentDetailView — Live status display for a single SessionDO instance.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useEffect, useMemo } from 'react'
import { StatusBar } from '~/components/status-bar'
import { type BranchInfoRow, createBranchInfoCollection } from '~/db/branch-info-collection'
import { projectsCollection } from '~/db/projects-collection'
import { upsertSessionLiveState } from '~/db/session-live-state-collection'
import type { ProjectInfo } from '~/lib/types'
import { useStatusBarStore } from '~/stores/status-bar'
import { ChatThread } from './ChatThread'
import { ConversationDownload } from './ConversationDownload'
import { KataStatePanel } from './KataStatePanel'
import { MessageInput } from './MessageInput'
import type { UseCodingAgentResult } from './use-coding-agent'

interface AgentDetailViewProps {
  name: string
  agent: UseCodingAgentResult
}

export function AgentDetailView({ name: sessionId, agent }: AgentDetailViewProps) {
  const {
    state,
    messages,
    kataState,
    isConnecting,
    stop,
    interrupt,
    resolveGate,
    sendMessage,
    submitDraft,
    rewind,
    injectQaPair,
    navigateBranch,
  } = agent

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
    const map = new Map<string, { current: number; total: number; siblings: string[] }>()
    if (!branchInfoRows) return map
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

  // Keep worktree info in the live-state collection. projectsCollection is
  // a query-backed collection with a 30s refetch interval — replaces the
  // old manual poll that used to live here.
  const projectName = state?.project
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: projectsData } = useLiveQuery((q) => q.from({ p: projectsCollection as any }))

  const matchedProject = useMemo<ProjectInfo | null>(() => {
    if (!projectName || !projectsData) return null
    return (projectsData as unknown as ProjectInfo[]).find((p) => p.name === projectName) ?? null
  }, [projectsData, projectName])

  useEffect(() => {
    if (!projectName) {
      upsertSessionLiveState(sessionId, { worktreeInfo: null })
      return
    }
    if (!matchedProject) return
    upsertSessionLiveState(sessionId, {
      worktreeInfo: {
        name: matchedProject.name,
        branch: matchedProject.branch,
        dirty: matchedProject.dirty,
        ahead: matchedProject.ahead ?? 0,
        behind: matchedProject.behind ?? 0,
        pr: matchedProject.pr ?? null,
      },
    })
  }, [sessionId, projectName, matchedProject])

  const handleSendSuggestion = useCallback(
    (text: string) => {
      sendMessage(text)
    },
    [sendMessage],
  )

  const status = state?.status ?? 'idle'

  // Draft key scopes localStorage drafts. Now that tabs ARE sessions (Yjs
  // Y.Array of sessionIds), use sessionId directly — no separate tab ID.
  const draftKey = sessionId

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
      data-testid="agent-detail-view"
    >
      <KataStatePanel kataState={kataState} />

      <div className="flex items-center justify-end px-4 py-1">
        <ConversationDownload messages={messages} sessionId={state?.session_id ?? 'unknown'} />
      </div>

      <ChatThread
        messages={messages}
        gate={state?.gate ?? null}
        status={status}
        state={state}
        isConnecting={isConnecting}
        onResolveGate={resolveGate}
        onQaResolved={injectQaPair}
        onRewind={rewind}
        branchInfo={branchInfo}
        onBranchNavigate={navigateBranch}
        onSendSuggestion={handleSendSuggestion}
      />

      <StatusBar sessionId={sessionId} />
      <MessageInput
        onSend={sendMessage}
        submitDraft={submitDraft}
        sessionId={sessionId}
        disabled={status === 'waiting_gate'}
        status={state?.status}
        onInterrupt={interrupt}
        draftKey={draftKey}
      />
    </div>
  )
}
