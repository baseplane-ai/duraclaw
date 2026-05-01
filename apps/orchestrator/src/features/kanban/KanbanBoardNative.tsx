/**
 * Native kanban board — Expo SDK 55 (GH#157 §1 + §5).
 *
 * Drag-to-advance built on `react-native-reanimated-dnd`:
 *   - Each column is a `Droppable` keyed `drop:<column>`.
 *   - Each arc card is a `Draggable<{ arcId: string }>`.
 *   - On drop, parse the dest column id, validate adjacency
 *     (single-step left-to-right; web-parity), run the
 *     precondition gate, and open the AdvanceConfirmModalNative.
 *   - Confirm calls `advanceArc(arc, nextMode, { projectOverride })`;
 *     the new session arrives via WS deltas through arcsCollection /
 *     sessionsCollection and re-renders here.
 *
 * Layout: a horizontal `ScrollView` of fixed-width column views so
 * the user can pan across the 6 columns. Each column is a vertical
 * `ScrollView` of arc cards (with `Droppable` wrapping the column).
 *
 * Why no AlertDialog/Toast on native: the spec ships a plain RN
 * `Alert.alert(...)` for "can't move backwards" / precondition-fail
 * to keep parity with the web `toast.error(...)` semantics — fast
 * surfacing of why the drop didn't take. Sonner toasts (web's
 * default) don't have an RN port that's worth pulling in for one
 * call site.
 *
 * `DropProvider` wraps the whole board. It coordinates the active
 * drag's gesture state across all Droppables.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { Draggable, DraggableState, DropProvider, Droppable } from 'react-native-reanimated-dnd'
import { arcsCollection } from '~/db/arcs-collection'
import { projectsCollection } from '~/db/projects-collection'
import { checkPrecondition } from '~/hooks/use-arc-preconditions'
import { deriveColumn, type KanbanColumn } from '~/lib/arcs'
import type { ArcSummary } from '~/lib/types'
import { AdvanceConfirmModalNative } from './AdvanceConfirmModalNative'
import { advanceArc } from './advance-arc'

const COLUMNS: ReadonlyArray<KanbanColumn> = [
  'backlog',
  'research',
  'planning',
  'implementation',
  'verify',
  'done',
]

const COLUMN_LABELS: Record<KanbanColumn, string> = {
  backlog: 'Backlog',
  research: 'Research',
  planning: 'Planning',
  implementation: 'Implementation',
  verify: 'Verify',
  done: 'Done',
}

const COLUMN_WIDTH = 260
const COLUMN_GAP = 12

type DragPayload = { arcId: string }

export function KanbanBoardNative() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(arcsCollection as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: projectsData } = useLiveQuery(projectsCollection as any)

  const arcs = useMemo(() => {
    if (!data) return [] as ArcSummary[]
    return (data as ArcSummary[]).filter((a) => a.status === 'draft' || a.status === 'open')
  }, [data])

  const projectOptions = useMemo(() => {
    if (!projectsData) return [] as string[]
    return (projectsData as Array<{ name: string }>).map((p) => p.name).sort()
  }, [projectsData])

  const byColumn = useMemo(() => {
    const out: Record<KanbanColumn, ArcSummary[]> = {
      backlog: [],
      research: [],
      planning: [],
      implementation: [],
      verify: [],
      done: [],
    }
    for (const arc of arcs) {
      const col = deriveColumn(arc.sessions, arc.status)
      out[col].push(arc)
    }
    return out
  }, [arcs])

  const [pendingAdvance, setPendingAdvance] = useState<{
    arc: ArcSummary
    nextMode: string
  } | null>(null)
  const [pending, setPending] = useState(false)
  const [pickedProject, setPickedProject] = useState<string>('')

  const onDrop = useCallback(
    async (payload: DragPayload, destCol: KanbanColumn) => {
      const arc = arcs.find((a) => a.id === payload.arcId)
      if (!arc) return

      const fromCol = deriveColumn(arc.sessions, arc.status)
      const fromIdx = COLUMNS.indexOf(fromCol)
      const toIdx = COLUMNS.indexOf(destCol)
      if (fromIdx < 0 || toIdx < 0 || toIdx === fromIdx) return
      if (toIdx < fromIdx) {
        Alert.alert("Can't move backwards")
        return
      }
      if (toIdx !== fromIdx + 1) {
        Alert.alert("Can't move to non-adjacent column")
        return
      }

      const res = await checkPrecondition(arc)
      if (!res.canAdvance || !res.nextMode) {
        Alert.alert('Precondition not met', res.reason || 'Cannot advance this arc.')
        return
      }

      // Reset the picker each time we open the modal so a stale selection
      // from a prior drag doesn't survive into a new one.
      setPickedProject('')
      setPendingAdvance({ arc, nextMode: res.nextMode })
    },
    [arcs],
  )

  const onConfirm = useCallback(async () => {
    if (!pendingAdvance) return
    setPending(true)
    const { arc, nextMode } = pendingAdvance
    const projectOverride = arc.sessions.length === 0 && pickedProject ? pickedProject : null
    const res = await advanceArc(arc, nextMode, { projectOverride })
    setPending(false)
    setPendingAdvance(null)
    if (!res.ok) {
      Alert.alert('Advance failed', res.error ?? 'Unknown error')
      return
    }
    Alert.alert('Started', `Started ${nextMode} in arc '${arc.title}'`)
  }, [pendingAdvance, pickedProject])

  return (
    <GestureHandlerRootView style={styles.flex}>
      <DropProvider>
        <View style={styles.flex}>
          <View style={styles.header}>
            <Text style={styles.title}>Board</Text>
            <Text style={styles.subtitle}>
              {arcs.length} arc{arcs.length === 1 ? '' : 's'}
              {isLoading ? ' · loading…' : ''}
            </Text>
          </View>

          <ScrollView
            contentContainerStyle={styles.boardContent}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.flex}
          >
            {COLUMNS.map((col) => (
              <Column key={col} column={col} arcs={byColumn[col]} onDrop={(p) => onDrop(p, col)} />
            ))}
          </ScrollView>

          {pendingAdvance ? (
            <AdvanceConfirmModalNative
              open
              onOpenChange={(o) => {
                if (!o) setPendingAdvance(null)
              }}
              arcTitle={pendingAdvance.arc.title}
              currentMode={deriveColumn(pendingAdvance.arc.sessions, pendingAdvance.arc.status)}
              nextMode={pendingAdvance.nextMode}
              worktree={pendingAdvance.arc.worktreeReservation?.worktree.split('/').pop() ?? null}
              worktreeReserved={!!pendingAdvance.arc.worktreeReservation}
              projectOptions={pendingAdvance.arc.sessions.length === 0 ? projectOptions : undefined}
              selectedProject={pickedProject || null}
              onProjectChange={setPickedProject}
              onConfirm={onConfirm}
              pending={pending}
            />
          ) : null}
        </View>
      </DropProvider>
    </GestureHandlerRootView>
  )
}

function Column({
  column,
  arcs,
  onDrop,
}: {
  column: KanbanColumn
  arcs: ArcSummary[]
  onDrop: (data: DragPayload) => void
}) {
  return (
    <Droppable<DragPayload>
      droppableId={`drop:${column}`}
      onDrop={onDrop}
      style={styles.columnOuter}
      activeStyle={styles.columnActive}
    >
      <Text style={styles.columnTitle}>
        {COLUMN_LABELS[column]} ({arcs.length})
      </Text>
      <ScrollView contentContainerStyle={styles.columnInner} showsVerticalScrollIndicator={false}>
        {arcs.length === 0 ? (
          <View style={styles.emptyDrop}>
            <Text style={styles.emptyDropText}>Drop here to advance</Text>
          </View>
        ) : (
          arcs.map((arc) => <ArcCard key={arc.id} arc={arc} />)
        )}
      </ScrollView>
    </Droppable>
  )
}

function ArcCard({ arc }: { arc: ArcSummary }) {
  const externalLabel: string | null =
    arc.externalRef?.provider === 'github'
      ? `#${arc.externalRef.id}`
      : arc.externalRef?.id != null
        ? String(arc.externalRef.id)
        : null

  return (
    <Draggable<DragPayload>
      data={{ arcId: arc.id }}
      draggableId={arc.id}
      style={styles.cardOuter}
      onStateChange={(state) => {
        // Optional: collapse the long-press affordance once dragging starts.
        if (state === DraggableState.DRAGGING) {
          // no-op for now; reserved for haptic feedback hook
        }
      }}
    >
      <Text style={styles.cardTitle} numberOfLines={2}>
        {arc.title || externalLabel || arc.id.slice(0, 8)}
      </Text>
      <View style={styles.cardMeta}>
        <Text style={styles.cardMetaText}>{arc.status}</Text>
        <Text style={styles.cardMetaText}>·</Text>
        <Text style={styles.cardMetaText}>
          {arc.sessions.length} session{arc.sessions.length === 1 ? '' : 's'}
        </Text>
      </View>
    </Draggable>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 4,
  },
  title: { fontSize: 22, fontWeight: '700', color: '#f8fafc' },
  subtitle: { fontSize: 13, color: '#90a1b9' },
  boardContent: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: COLUMN_GAP,
    flexDirection: 'row',
  },
  columnOuter: {
    width: COLUMN_WIDTH,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
    padding: 12,
    minHeight: 360,
    marginRight: COLUMN_GAP,
  },
  columnActive: {
    borderColor: '#4c9fff',
    backgroundColor: 'rgba(76,159,255,0.10)',
  },
  columnTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#f8fafc',
    marginBottom: 8,
    letterSpacing: 1,
  },
  columnInner: { gap: 8 },
  emptyDrop: {
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: 'rgba(255,255,255,0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderRadius: 8,
  },
  emptyDropText: { color: '#62748e', fontSize: 12 },
  cardOuter: {
    backgroundColor: '#020919',
    borderColor: 'rgba(255,255,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    gap: 6,
    marginBottom: 8,
  },
  cardTitle: { fontSize: 14, fontWeight: '500', color: '#f8fafc' },
  cardMeta: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  cardMetaText: { fontSize: 11, color: '#90a1b9' },
})
