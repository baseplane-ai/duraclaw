/**
 * KanbanBoard — top-level surface for `/board`.
 *
 * GH#116 P4a: subscribes to `arcsCollection` and renders `ArcSummary`
 * rows. Lanes group by external-ref provider — GH-linked arcs land in
 * the `'github'` lane, everything else (implicit single-session arcs,
 * branch-only arcs, etc.) lands in `'standalone'`. Columns are derived
 * client-side via `deriveColumn(arc.sessions, arc.status)`.
 *
 * Drag-to-advance: cards are draggable, columns are droppable
 * (`drop:<lane>:<column>`), and onDragEnd runs the B9 precondition check
 * + B10 confirmation modal before delegating to advanceArc. Backlog
 * arcs (zero sessions) get a project picker in the modal — same
 * pattern as KanbanCard's Start-next flow — so the server has a
 * project to bind on the no-frontier branch.
 *
 * Adjacency rule: only strict single-step left-to-right drops are
 * accepted. Any other target is a no-op with a toast.
 */

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo, useState } from 'react'
import { Platform } from 'react-native'
import { toast } from 'sonner'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { arcsCollection } from '~/db/arcs-collection'
import { projectsCollection } from '~/db/projects-collection'
import { checkPrecondition } from '~/hooks/use-arc-preconditions'
import { useKanbanLanes } from '~/hooks/use-kanban-lanes'
import { useTabSync } from '~/hooks/use-tab-sync'
import { deriveColumn, type KanbanColumn } from '~/lib/arcs'
import type { ArcSummary } from '~/lib/types'
import { AdvanceConfirmModal } from './AdvanceConfirmModal'
import { advanceArc } from './advance-arc'
import { KanbanLane } from './KanbanLane'

/**
 * Lane derivation: arcs with a GitHub external-ref land in the
 * `'github'` lane; everything else (linear / plain / arc-less) lands
 * in `'standalone'`. Future providers can be split out of `'github'`
 * without changing the data shape.
 */
type Lane = 'github' | 'standalone'
const LANES: ReadonlyArray<Lane> = ['github', 'standalone']

const COLUMN_ORDER: KanbanColumn[] = [
  'backlog',
  'research',
  'planning',
  'implementation',
  'verify',
  'done',
]

function laneFor(arc: ArcSummary): Lane {
  return arc.externalRef?.provider === 'github' ? 'github' : 'standalone'
}

function parseDropId(id: string): { lane: string; column: KanbanColumn } | null {
  // `drop:<lane>:<column>`
  const parts = id.split(':')
  if (parts.length !== 3 || parts[0] !== 'drop') return null
  const col = parts[2] as KanbanColumn
  if (!COLUMN_ORDER.includes(col)) return null
  return { lane: parts[1], column: col }
}

/** Sentinel value for "all projects" (no filter). */
const ALL_PROJECTS = '__all__'

export function KanbanBoard() {
  // GH#132 P3.3 (B7): native render uses react-native-reanimated-dnd
  // primitives. The full integration (column DropProviders + Draggable
  // ArcCards + onDrop → advanceArc round-trip) is ~200 LOC and is
  // implemented in `KanbanBoardNative.tsx` (lazy-loaded so web bundles
  // never import react-native-reanimated-dnd). The current native
  // module is a placeholder pending the use-and-fix gate; it renders a
  // read-only list of arcs grouped by lane so the /board route still
  // mounts without crashing.
  if (Platform.OS !== 'web') {
    // Lazy import via a relative path resolved by Metro at bundle time.
    // The web build never reaches this branch so Vite never tries to
    // resolve KanbanBoardNative — keeps `react-native-reanimated-dnd`
    // out of the orchestrator web bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const KanbanBoardNative = require('./KanbanBoardNative').KanbanBoardNative
    return <KanbanBoardNative />
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(arcsCollection as any)
  const { isCollapsed, toggle } = useKanbanLanes()
  const { openTab } = useTabSync()
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS)

  // Only the in-flight statuses (`draft`, `open`) belong on the board.
  // The server's GET /api/arcs default already excludes `closed` /
  // `archived` at cold-start; the client-side filter mirrors that
  // contract so a freshly-closed arc disappears immediately on the
  // broadcasted status='closed' delta, instead of lingering in its
  // last column until the next collection refresh.
  const arcs = useMemo(() => {
    if (!data) return [] as ArcSummary[]
    return (data as ArcSummary[]).filter((a) => a.status === 'draft' || a.status === 'open')
  }, [data])

  // Project list derived from each arc's worktree reservation label
  // (`worktreeReservation.worktree` is the full path; the UI label is
  // the basename). ArcSummary no longer carries per-session `project`,
  // so the filter dropdown only reflects arcs that have actually
  // reserved a worktree.
  const projects = useMemo(() => {
    const set = new Set<string>()
    for (const arc of arcs) {
      const label = arc.worktreeReservation?.worktree.split('/').pop()
      if (label) set.add(label)
    }
    return [...set].sort()
  }, [arcs])

  // Apply project filter: keep arcs whose worktree label matches.
  // Arcs with no worktree always show (read-only / freshly-spawned).
  const filtered = useMemo(() => {
    if (projectFilter === ALL_PROJECTS) return arcs
    return arcs.filter((a) => {
      const label = a.worktreeReservation?.worktree.split('/').pop()
      return !label || label === projectFilter
    })
  }, [arcs, projectFilter])

  const byLane = useMemo(() => {
    const out: Record<Lane, ArcSummary[]> = {
      github: [],
      standalone: [],
    }
    for (const arc of filtered) {
      out[laneFor(arc)].push(arc)
    }
    return out
  }, [filtered])

  // Touch needs a long-press to activate so horizontal lane scrolling
  // (overflow-x-auto on KanbanLane) still works. Mouse uses a small
  // distance threshold so accidental clicks don't initiate a drag.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor),
  )

  // Drag-driven confirmation modal state.
  const [pendingAdvance, setPendingAdvance] = useState<{
    arc: ArcSummary
    nextMode: string
  } | null>(null)
  const [pending, setPending] = useState(false)

  // Backlog-bootstrap on drag: when a zero-session arc is dragged into
  // its first lane, the modal renders a project picker (same pattern as
  // KanbanCard's Start-next flow). The pick threads through advanceArc
  // as `projectOverride`; without it the server 400s `no_project_for_arc`.
  const [pickedProject, setPickedProject] = useState<string>('')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: projectsData } = useLiveQuery(projectsCollection as any)
  const projectOptions = useMemo(() => {
    if (!projectsData) return [] as string[]
    return (projectsData as Array<{ name: string }>).map((p) => p.name).sort()
  }, [projectsData])

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const over = event.over
    const arc = event.active.data.current?.arc as ArcSummary | undefined
    if (!over || !arc) return
    const dest = parseDropId(String(over.id))
    if (!dest) return

    const fromCol = deriveColumn(arc.sessions, arc.status)
    const fromIdx = COLUMN_ORDER.indexOf(fromCol)
    const toIdx = COLUMN_ORDER.indexOf(dest.column)
    if (fromIdx < 0 || toIdx < 0) return
    if (toIdx === fromIdx) return
    if (toIdx < fromIdx) {
      toast.error("Can't move backwards")
      return
    }
    if (toIdx !== fromIdx + 1) {
      toast.error("Can't move to non-adjacent column")
      return
    }

    // Drag-to-advance still goes through the precondition gate
    // (spec/vp checks). The precondition hook now reads ArcSummary
    // directly.
    const res = await checkPrecondition(arc)
    if (!res.canAdvance || !res.nextMode) {
      toast.error(res.reason || 'Precondition not met')
      return
    }
    // Reset the picker each time we open the modal so a stale selection
    // from a prior drag doesn't survive into a new one.
    setPickedProject('')
    setPendingAdvance({ arc, nextMode: res.nextMode })
  }, [])

  const handleConfirm = useCallback(async () => {
    if (!pendingAdvance) return
    setPending(true)
    const { arc, nextMode } = pendingAdvance
    const res = await advanceArc(arc, nextMode, {
      projectOverride: arc.sessions.length === 0 && pickedProject ? pickedProject : null,
    })
    setPending(false)
    setPendingAdvance(null)
    if (!res.ok) {
      toast.error(res.error ?? 'Failed to advance arc')
      return
    }
    toast.success(`Started ${nextMode} in arc '${arc.title}'`)
    const projectLabel = arc.worktreeReservation?.worktree.split('/').pop()
    openTab(res.sessionId, { project: projectLabel ?? undefined })
  }, [pendingAdvance, openTab, pickedProject])

  return (
    <>
      <Header>
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Board</h1>
          {projects.length > 0 ? (
            <Select value={projectFilter} onValueChange={setProjectFilter}>
              <SelectTrigger className="h-8 w-auto min-w-[140px] text-xs">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </Header>
      <Main fluid fixed>
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
            {isLoading && arcs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Loading arcs…</p>
            ) : null}
            {LANES.filter((lane) => byLane[lane].length > 0).map((lane) => (
              <KanbanLane
                key={lane}
                name={lane}
                cards={byLane[lane]}
                collapsed={isCollapsed(lane)}
                onToggle={() => toggle(lane)}
              />
            ))}
            {!isLoading && arcs.length > 0 && LANES.every((lane) => byLane[lane].length === 0) ? (
              <p className="text-sm text-muted-foreground">No arcs match the current filter.</p>
            ) : null}
            {!isLoading && arcs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No arcs yet. Spawn a session with a GitHub issue ref to create one.
              </p>
            ) : null}
          </div>
        </DndContext>
        {pendingAdvance ? (
          <AdvanceConfirmModal
            open={true}
            onOpenChange={(open) => {
              if (!open) setPendingAdvance(null)
            }}
            arcTitle={pendingAdvance.arc.title}
            currentMode={deriveColumn(pendingAdvance.arc.sessions, pendingAdvance.arc.status)}
            nextMode={pendingAdvance.nextMode}
            worktree={pendingAdvance.arc.worktreeReservation?.worktree.split('/').pop() ?? null}
            worktreeReserved={!!pendingAdvance.arc.worktreeReservation}
            projectOptions={pendingAdvance.arc.sessions.length === 0 ? projectOptions : undefined}
            selectedProject={pickedProject || null}
            onProjectChange={setPickedProject}
            onConfirm={handleConfirm}
            pending={pending}
          />
        ) : null}
      </Main>
    </>
  )
}
