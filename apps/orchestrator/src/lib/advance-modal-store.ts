/**
 * Module-level singleton store for the global "advance arc" modal
 * (issue #151 arc-first UI overhaul, task TK-6484-0430).
 *
 * Only one advance modal can be open at a time across the whole app, so
 * the modal itself is mounted once at the layout level as
 * `<AdvanceModalHost />`. The modal's open/close + form state lives here
 * instead of in any individual trigger: both `KanbanCard` (kanban board)
 * and `ArcStatusItem` (status-bar popover) call `openAdvance(arc, nextMode)`
 * to summon the host, rather than each owning their own copy of the
 * modal + state.
 *
 * Intentionally tiny surface, no React inside the store itself; a
 * `useSyncExternalStore` hook is exposed for components but direct
 * imperative reads (`getAdvanceModalState()`) are fine too. Mirrors the
 * shape of `chain-stall-store.ts` (listener Set, try/catch broadcast).
 */

import { useSyncExternalStore } from 'react'
import type { ArcSummary, ChainWorktreeReservation } from '~/lib/types'

interface AdvanceModalState {
  arc: ArcSummary | null
  nextMode: string | null
  pickedProject: string
  pending: boolean
  conflict: ChainWorktreeReservation | null
}

const initialState: AdvanceModalState = {
  arc: null,
  nextMode: null,
  pickedProject: '',
  pending: false,
  conflict: null,
}

let state: AdvanceModalState = initialState
const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch (err) {
      console.warn('[advance-modal-store] listener threw', err)
    }
  }
}

export function openAdvance(arc: ArcSummary, nextMode: string): void {
  state = {
    arc,
    nextMode,
    pickedProject: '',
    pending: false,
    conflict: null,
  }
  notify()
}

export function closeAdvance(): void {
  state = {
    arc: null,
    nextMode: null,
    pickedProject: '',
    pending: false,
    conflict: null,
  }
  notify()
}

export function setPickedProject(project: string): void {
  state = { ...state, pickedProject: project }
  notify()
}

export function setPending(pending: boolean): void {
  state = { ...state, pending }
  notify()
}

export function setConflict(conflict: ChainWorktreeReservation | null): void {
  state = { ...state, conflict }
  notify()
}

export function getAdvanceModalState(): AdvanceModalState {
  return state
}

export function subscribeAdvanceModal(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * React hook: subscribe a component to the singleton advance-modal state.
 * Returns the initial (closed) state during SSR snapshot. The single
 * `<AdvanceModalHost />` mounted at layout level reads this to know
 * whether to render and what arc/nextMode to operate on.
 */
export function useAdvanceModalState(): AdvanceModalState {
  return useSyncExternalStore(subscribeAdvanceModal, getAdvanceModalState, () => initialState)
}
