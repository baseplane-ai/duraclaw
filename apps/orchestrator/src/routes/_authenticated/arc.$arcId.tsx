/**
 * /arc/:arcId — Arc detail view (GH#116 P4b B15).
 *
 * Renders a single arc's metadata and its session timeline. Reads
 * `arcsCollection` reactively (no separate fetch — the arc list is
 * already kept fresh by `UserSettingsDO` synced-collection deltas).
 *
 * Surfaces:
 *   - Editable title (PATCH /api/arcs/:id on blur; reverts on empty
 *     title or on PATCH failure; optimistic state during the request).
 *   - External-ref badge — clickable for `provider === 'github'`,
 *     plain text otherwise.
 *   - Worktree reservation badge — basename of the worktree path plus
 *     a relative "held since" timestamp.
 *   - Session timeline newest-first: each row shows mode, status, a
 *     relative lastActivity stamp, and clicks navigate to the
 *     session-by-query-param tab convention (`/?session=:id`) so the
 *     existing tab/picker UX is preserved.
 *   - Branch tree: parent arc link if `parentArcId` set, side-arc
 *     children list if any other arcs reference this arc as parent.
 *   - Breadcrumbs back to `/board` and `/`.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { Badge } from '~/components/ui/badge'
import { Skeleton } from '~/components/ui/skeleton'
import { arcsCollection } from '~/db/arcs-collection'
import { useTabSync } from '~/hooks/use-tab-sync'
import { apiUrl } from '~/lib/platform'
import type { ArcSummary } from '~/lib/types'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/_authenticated/arc/$arcId')({
  component: ArcDetailRoute,
})

// ── Helpers ────────────────────────────────────────────────────────

/** "Just now" / "5m ago" / "3h ago" / "2d ago" relative-past formatter. */
function formatRelativePast(iso: string | null): string | null {
  if (!iso) return null
  const target = new Date(iso).getTime()
  if (Number.isNaN(target)) return null
  const deltaMs = Date.now() - target
  if (deltaMs < 0) return 'just now'
  const mins = Math.round(deltaMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

/** Statuses where the runner is still attached / awaiting input. */
const ONLINE_STATUSES = new Set(['running', 'waiting_input', 'waiting_permission', 'waiting_gate'])

// ── Editable title ─────────────────────────────────────────────────

function EditableTitle({ arcId, initialTitle }: { arcId: string; initialTitle: string }) {
  const [value, setValue] = useState(initialTitle)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastSavedRef = useRef(initialTitle)

  // External updates (server echoed delta) re-sync the input when the
  // user isn't actively editing.
  useEffect(() => {
    if (!pending && document.activeElement?.getAttribute('data-arc-title-input') !== arcId) {
      setValue(initialTitle)
      lastSavedRef.current = initialTitle
    }
  }, [arcId, initialTitle, pending])

  const commit = useCallback(async () => {
    const next = value.trim()
    if (!next) {
      setValue(lastSavedRef.current)
      setError(null)
      return
    }
    if (next === lastSavedRef.current) {
      setError(null)
      return
    }
    setPending(true)
    setError(null)
    try {
      const resp = await fetch(apiUrl(`/api/arcs/${encodeURIComponent(arcId)}`), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: next }),
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        setValue(lastSavedRef.current)
        setError(body || `HTTP ${resp.status}`)
      } else {
        lastSavedRef.current = next
      }
    } catch (err) {
      setValue(lastSavedRef.current)
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setPending(false)
    }
  }, [arcId, value])

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        data-arc-title-input={arcId}
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          void commit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.currentTarget as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            setValue(lastSavedRef.current)
            ;(e.currentTarget as HTMLInputElement).blur()
          }
        }}
        className={cn(
          'min-w-0 flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-lg font-semibold',
          'hover:border-border focus:border-ring focus:outline-none',
          pending && 'opacity-60',
        )}
        aria-label="Arc title"
      />
      {error && (
        <span className="text-destructive text-xs" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

// ── External ref badge ─────────────────────────────────────────────

function ExternalRefBadge({ ref: externalRef }: { ref: ArcSummary['externalRef'] }) {
  if (!externalRef) return null
  if (externalRef.provider === 'github' && externalRef.url) {
    return (
      <a
        href={externalRef.url}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center"
      >
        <Badge variant="outline" className="hover:bg-muted">
          #{String(externalRef.id)}
        </Badge>
      </a>
    )
  }
  return (
    <Badge variant="outline">
      {externalRef.provider}: {String(externalRef.id)}
    </Badge>
  )
}

// ── Worktree reservation badge ─────────────────────────────────────

function WorktreeReservationBadge({
  reservation,
}: {
  reservation: ArcSummary['worktreeReservation']
}) {
  if (!reservation) return null
  const label = reservation.worktree.split('/').pop() || reservation.worktree
  const heldSince = formatRelativePast(reservation.heldSince)
  return (
    <Link to="/" className="inline-flex items-center" title={`Worktree: ${reservation.worktree}`}>
      <Badge variant={reservation.stale ? 'destructive' : 'secondary'} className="gap-1">
        <span className="font-mono">{label}</span>
        {heldSince && <span className="text-[10px] opacity-80">held {heldSince}</span>}
      </Badge>
    </Link>
  )
}

// ── Session timeline row ───────────────────────────────────────────

function SessionRow({
  session,
  onSelect,
}: {
  session: ArcSummary['sessions'][number]
  onSelect: (sessionId: string) => void
}) {
  const online = ONLINE_STATUSES.has(session.status)
  const lastActivity = formatRelativePast(session.lastActivity ?? session.createdAt)
  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      className="flex w-full items-center gap-3 rounded border bg-card px-3 py-2 text-left text-sm hover:bg-muted"
    >
      <span
        className={cn(
          'inline-block size-2 shrink-0 rounded-full',
          online ? 'bg-green-500' : 'bg-muted-foreground/40',
        )}
        title={online ? 'online' : 'offline'}
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">
          {session.mode || <span className="text-muted-foreground">no mode</span>}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {session.status}
          {lastActivity ? ` · ${lastActivity}` : ''}
        </span>
      </div>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {session.id.slice(0, 8)}
      </span>
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────

function ArcDetailRoute() {
  const { arcId } = Route.useParams()
  const navigate = useNavigate()
  const { openTab } = useTabSync()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(arcsCollection as any)

  const allArcs = useMemo<ArcSummary[]>(() => (data ? ([...data] as ArcSummary[]) : []), [data])

  const arc = useMemo<ArcSummary | null>(
    () => allArcs.find((a) => a.id === arcId) ?? null,
    [allArcs, arcId],
  )

  const parentArc = useMemo<ArcSummary | null>(() => {
    if (!arc?.parentArcId) return null
    return allArcs.find((a) => a.id === arc.parentArcId) ?? null
  }, [allArcs, arc])

  const childArcs = useMemo<ArcSummary[]>(() => {
    if (!arc) return []
    return allArcs.filter((a) => a.parentArcId === arc.id)
  }, [allArcs, arc])

  // Sessions newest-first by lastActivity ?? createdAt.
  const sortedSessions = useMemo(() => {
    if (!arc) return []
    return [...arc.sessions].sort((a, b) => {
      const aTs = new Date(a.lastActivity ?? a.createdAt).getTime()
      const bTs = new Date(b.lastActivity ?? b.createdAt).getTime()
      return bTs - aTs
    })
  }, [arc])

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      openTab(sessionId)
      navigate({ to: '/', search: { session: sessionId } })
    },
    [navigate, openTab],
  )

  // Loading skeleton — collection has not produced a snapshot yet.
  if (isLoading && !arc) {
    return (
      <>
        <Header>
          <h1 className="text-lg font-semibold">Arc</h1>
        </Header>
        <Main>
          <div className="flex flex-col gap-4">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        </Main>
      </>
    )
  }

  // Loaded but arc not found — 404 surface.
  if (!arc) {
    return (
      <>
        <Header>
          <h1 className="text-lg font-semibold">Arc</h1>
        </Header>
        <Main>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">Arc not found.</p>
            <p className="text-xs text-muted-foreground">id: {arcId}</p>
            <div className="flex gap-2 pt-2">
              <Link to="/board" className="text-sm underline-offset-2 hover:underline">
                ← Back to board
              </Link>
              <Link to="/" className="text-sm underline-offset-2 hover:underline">
                ← Back to home
              </Link>
            </div>
          </div>
        </Main>
      </>
    )
  }

  return (
    <>
      <Header>
        <nav className="flex items-center gap-2 text-sm">
          <Link to="/" className="text-muted-foreground hover:text-foreground">
            Home
          </Link>
          <span className="text-muted-foreground">/</span>
          <Link to="/board" className="text-muted-foreground hover:text-foreground">
            Board
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="font-medium">Arc</span>
        </nav>
      </Header>
      <Main>
        <div className="flex flex-col gap-6">
          {/* Title + meta row */}
          <header className="flex flex-col gap-2">
            <EditableTitle arcId={arc.id} initialTitle={arc.title} />
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="capitalize">
                {arc.status}
              </Badge>
              <ExternalRefBadge ref={arc.externalRef} />
              <WorktreeReservationBadge reservation={arc.worktreeReservation} />
              {arc.prNumber && (
                <Badge variant="outline" className="font-mono">
                  PR #{arc.prNumber}
                </Badge>
              )}
            </div>
          </header>

          {/* Branch tree */}
          {(parentArc || childArcs.length > 0) && (
            <section className="flex flex-col gap-2">
              {parentArc && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Forked from </span>
                  <Link
                    to="/arc/$arcId"
                    params={{ arcId: parentArc.id }}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {parentArc.title}
                  </Link>
                </div>
              )}
              {childArcs.length > 0 && (
                <div className="flex flex-col gap-1">
                  <div className="text-sm font-medium">Side arcs ({childArcs.length})</div>
                  <ul className="flex flex-col gap-1">
                    {childArcs.map((c) => (
                      <li key={c.id} className="text-sm">
                        <Link
                          to="/arc/$arcId"
                          params={{ arcId: c.id }}
                          className="underline-offset-2 hover:underline"
                        >
                          {c.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* Session timeline */}
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Sessions ({sortedSessions.length})
            </h2>
            {sortedSessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sessions in this arc yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {sortedSessions.map((s) => (
                  <li key={s.id}>
                    <SessionRow session={s} onSelect={handleSelectSession} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </Main>
    </>
  )
}
