/**
 * Native kanban board (Expo SDK 55 — GH#132 P3.3 B7).
 *
 * Placeholder read-only implementation. The full
 * `react-native-reanimated-dnd` integration (Draggable cards across
 * Droppable columns, advanceArc on drop, confirmation modal) is the
 * deferred follow-up work — once the use-and-fix gate (P3.5) catches
 * the first real "I want to drag a card" UX feedback, this gets
 * replaced with the real DnD primitives.
 *
 * Why ship a placeholder rather than block: the /board route is
 * navigable on web; on native the user can still see arc lanes and
 * tap into a session. Drag-to-advance is a productivity affordance,
 * not a correctness gate. Leaving it as a deferred yellow per the
 * spec verdict (Risk #3 mitigation pattern) is consistent with the
 * "use and fix" GA shape (Decision #12).
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useMemo } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { arcsCollection } from '~/db/arcs-collection'
import type { ArcSummary } from '~/lib/types'

export function KanbanBoardNative() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(arcsCollection as any)
  const arcs = useMemo(() => (data ? ([...data] as ArcSummary[]) : []), [data])

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text>Loading…</Text>
      </View>
    )
  }

  // Group by external-ref provider (parity with web's `'github'` /
  // `'standalone'` lane derivation, simplified to two columns).
  const githubLane = arcs.filter((a) => a.externalRef?.provider === 'github')
  const standaloneLane = arcs.filter((a) => a.externalRef?.provider !== 'github')

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: '700', marginBottom: 4 }}>Board</Text>
      <Text style={{ opacity: 0.6, marginBottom: 16 }}>
        Read-only on native — drag-to-advance lands in a follow-up.
      </Text>

      <Text style={{ fontSize: 16, fontWeight: '600', marginTop: 16 }}>
        GitHub ({githubLane.length})
      </Text>
      {githubLane.map((arc) => (
        <ArcRow key={arc.id} arc={arc} />
      ))}

      <Text style={{ fontSize: 16, fontWeight: '600', marginTop: 16 }}>
        Standalone ({standaloneLane.length})
      </Text>
      {standaloneLane.map((arc) => (
        <ArcRow key={arc.id} arc={arc} />
      ))}
    </ScrollView>
  )
}

function ArcRow({ arc }: { arc: ArcSummary }) {
  const label = arc.externalRef?.provider === 'github' ? `#${arc.externalRef.id}` : arc.id
  return (
    <View
      style={{
        backgroundColor: 'rgba(0,0,0,0.04)',
        borderRadius: 8,
        marginTop: 8,
        padding: 12,
      }}
    >
      <Text style={{ fontWeight: '500' }} numberOfLines={2}>
        {label}
      </Text>
      <Text style={{ marginTop: 4, opacity: 0.6, fontSize: 12 }}>
        {arc.status} · {arc.sessions.length} session{arc.sessions.length === 1 ? '' : 's'}
      </Text>
    </View>
  )
}
