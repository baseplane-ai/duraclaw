/**
 * ChainPage — `/chain/:issueNumber` body.
 *
 * P1 scope: render the vertical timeline of sessions that belong to the
 * given issueNumber. Opens (or focuses) the corresponding chain tab on
 * mount so the tab bar stays in sync with the URL.
 *
 * Worktree reservation badge, GH issue title fetch, artifact chips, and
 * the "Start research" spawn wiring are deferred to later units.
 */

import { useEffect, useMemo, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '~/components/ui/button'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { useSessionLiveState } from '~/hooks/use-session-live-state'
import { useTabSync } from '~/hooks/use-tab-sync'
import { ChainHeader } from './ChainHeader'
import { ChainTimelineRow } from './ChainTimelineRow'

interface ChainPageProps {
  issueNumber: number
}

const TERMINAL = new Set(['completed', 'crashed'])

export function ChainPage({ issueNumber }: ChainPageProps) {
  const valid = Number.isFinite(issueNumber)
  const { sessions } = useSessionsCollection()
  const { openTab } = useTabSync()

  // Sync the chain tab once per mount so the tab bar highlights this
  // chain. openTab is idempotent (one-chain-per-issue) but we still
  // guard against effect re-runs that would re-activate on every render.
  const openedRef = useRef(false)
  useEffect(() => {
    if (openedRef.current) return
    if (!valid) return
    openedRef.current = true
    openTab(`chain:${issueNumber}`, { kind: 'chain', issueNumber })
  }, [valid, issueNumber, openTab])

  const chainSessions = useMemo(
    () =>
      valid
        ? sessions
            .filter((s) => s.kataIssue === issueNumber)
            .sort(
              (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
            )
        : [],
    [sessions, issueNumber, valid],
  )

  // Prefer the most recent running / waiting session as the expanded row.
  const activeSession = useMemo(() => {
    const candidates = chainSessions.filter(
      (s) => !TERMINAL.has(String(s.status || 'idle')),
    )
    if (candidates.length === 0) return null
    return candidates[candidates.length - 1]
  }, [chainSessions])

  const activeLive = useSessionLiveState(activeSession?.id ?? null)

  // NaN / invalid param — show a friendly bail-out instead of 500ing.
  if (!valid) {
    return (
      <>
        <Header>
          <h1 className="text-lg font-semibold">Invalid chain URL</h1>
        </Header>
        <Main>
          <div className="mx-auto max-w-3xl">
            <p className="text-sm text-muted-foreground mb-3">
              The URL parameter must be a numeric issue number.
            </p>
            <Button asChild variant="outline">
              <Link to="/">Back</Link>
            </Button>
          </div>
        </Main>
      </>
    )
  }
  // SessionLiveState currently doesn't carry a partial-assistant text
  // field; surface the session summary as a lightweight live indicator
  // when nothing else is available. Full streaming transcript rendering
  // is deferred to a later unit that hooks into messagesCollection.
  const liveText = activeLive.state?.summary ?? undefined

  const title = chainSessions[0]?.title ?? undefined
  const workspace = chainSessions[0]?.project ?? undefined

  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Chain #{issueNumber}</h1>
      </Header>
      <Main>
        <div className="mx-auto max-w-3xl">
          <ChainHeader
            issueNumber={issueNumber}
            title={title}
            workspace={workspace}
          />

          {chainSessions.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center">
              <p className="text-sm text-muted-foreground mb-3">
                No sessions for this issue yet.
              </p>
              <Button
                variant="outline"
                disabled
                title="Spawn wiring lands with the kanban (P3)."
              >
                Start research
              </Button>
              {/* TODO P3: wire this button to spawn a kata research session for
                  issueNumber. P1 is UI-only. */}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {chainSessions.map((s) => (
                <ChainTimelineRow
                  key={s.id}
                  session={s}
                  active={activeSession?.id === s.id}
                  liveText={activeSession?.id === s.id ? liveText : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </Main>
    </>
  )
}
