/**
 * ChainPage — `/chain/:issueNumber` body.
 *
 * P3 U3 wires the empty-state "Start research" CTA to an actual spawn:
 * picks the chain's project from `chainsCollection` when known, otherwise
 * shows a lightweight inline `<select>` populated from `projectsCollection`.
 * On spawn we navigate into the new session so the user sees it live.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { Link, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { Button } from '~/components/ui/button'
import { chainsCollection } from '~/db/chains-collection'
import { projectsCollection } from '~/db/projects-collection'
import { chainProject, spawnChainSession } from '~/features/kanban/advance-chain'
import { useSessionLiveState } from '~/hooks/use-session-live-state'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { useTabSync } from '~/hooks/use-tab-sync'
import type { ChainSummary, ProjectInfo } from '~/lib/types'
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
  const navigate = useNavigate()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: chainsData } = useLiveQuery(chainsCollection as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: projectsData } = useLiveQuery(projectsCollection as any)

  const chain = useMemo<ChainSummary | null>(() => {
    const list = (chainsData ?? []) as ChainSummary[]
    return list.find((c) => c.issueNumber === issueNumber) ?? null
  }, [chainsData, issueNumber])

  const projects = useMemo<ProjectInfo[]>(
    () => (projectsData ? ([...projectsData] as ProjectInfo[]) : []),
    [projectsData],
  )

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

  // Project selection for the "Start research" empty-state CTA. Default
  // to the chain's known project (from chainsCollection) if available.
  const knownProject = chain ? chainProject(chain) : null
  const [selectedProject, setSelectedProject] = useState<string>('')
  useEffect(() => {
    if (knownProject && !selectedProject) setSelectedProject(knownProject)
  }, [knownProject, selectedProject])

  const [spawning, setSpawning] = useState(false)

  const handleStartResearch = useCallback(async () => {
    const project = knownProject || selectedProject
    if (!project) {
      toast.error('Pick a project to start research')
      return
    }
    setSpawning(true)
    try {
      const sessionId = await spawnChainSession({
        project,
        agent: 'research',
        issueNumber,
      })
      toast.success(`Started research for #${issueNumber}`)
      navigate({
        to: '/session/$id',
        params: { id: sessionId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Spawn failed')
    } finally {
      setSpawning(false)
    }
  }, [knownProject, selectedProject, issueNumber, navigate])

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

  const title = chain?.issueTitle ?? chainSessions[0]?.title ?? undefined
  const workspace = knownProject ?? chainSessions[0]?.project ?? undefined
  const prNumber = chain?.prNumber

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
              {!knownProject ? (
                <div className="mb-3 flex justify-center">
                  <select
                    value={selectedProject}
                    onChange={(e) => setSelectedProject(e.target.value)}
                    className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                  >
                    <option value="">Select project…</option>
                    {projects.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <Button
                variant="outline"
                disabled={spawning || (!knownProject && !selectedProject)}
                onClick={handleStartResearch}
              >
                {spawning ? 'Starting…' : 'Start research'}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {chainSessions.map((s) => (
                <ChainTimelineRow
                  key={s.id}
                  session={s}
                  active={activeSession?.id === s.id}
                  liveText={activeSession?.id === s.id ? liveText : undefined}
                  prNumber={prNumber}
                />
              ))}
            </div>
          )}
        </div>
      </Main>
    </>
  )
}
