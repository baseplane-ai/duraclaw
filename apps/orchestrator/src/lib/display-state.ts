/**
 * display-state — Centralized session status-to-UI derivation (B10).
 *
 * Consumed by StatusBar, SessionListItem / SessionCardList (sidebar), and
 * the tab bar so every surface agrees on the label / color / icon /
 * interactivity for a given `SessionState.status` + WS `readyState` pair.
 *
 * Before this module each surface hand-rolled its own `switch (status)`;
 * callers now pass `(state, wsReadyState)` and render from the returned
 * discriminated union.
 */

import type { SessionState } from '~/lib/types'

export type DisplayState =
  | { status: 'running'; label: 'Running'; color: 'green'; icon: 'spinner'; isInteractive: true }
  | { status: 'idle'; label: 'Idle'; color: 'gray'; icon: 'circle'; isInteractive: true }
  | {
      status: 'waiting_gate'
      label: 'Needs Attention'
      color: 'amber'
      icon: 'alert'
      isInteractive: true
    }
  | { status: 'error'; label: 'Error'; color: 'red'; icon: 'x-circle'; isInteractive: false }
  | { status: 'archived'; label: 'Archived'; color: 'gray'; icon: 'archive'; isInteractive: false }
  | {
      status: 'disconnected'
      label: 'Disconnected'
      color: 'gray'
      icon: 'wifi-off'
      isInteractive: false
    }
  | { status: 'unknown'; label: 'Unknown'; color: 'gray'; icon: 'circle'; isInteractive: false }

const RUNNING: DisplayState = {
  status: 'running',
  label: 'Running',
  color: 'green',
  icon: 'spinner',
  isInteractive: true,
}

const IDLE: DisplayState = {
  status: 'idle',
  label: 'Idle',
  color: 'gray',
  icon: 'circle',
  isInteractive: true,
}

const WAITING_GATE: DisplayState = {
  status: 'waiting_gate',
  label: 'Needs Attention',
  color: 'amber',
  icon: 'alert',
  isInteractive: true,
}

const ERROR: DisplayState = {
  status: 'error',
  label: 'Error',
  color: 'red',
  icon: 'x-circle',
  isInteractive: false,
}

const ARCHIVED: DisplayState = {
  status: 'archived',
  label: 'Archived',
  color: 'gray',
  icon: 'archive',
  isInteractive: false,
}

const DISCONNECTED: DisplayState = {
  status: 'disconnected',
  label: 'Disconnected',
  color: 'gray',
  icon: 'wifi-off',
  isInteractive: false,
}

const UNKNOWN: DisplayState = {
  status: 'unknown',
  label: 'Unknown',
  color: 'gray',
  icon: 'circle',
  isInteractive: false,
}

/**
 * Derive the UI display state for a session given its latest `SessionState`
 * and the current WS `readyState`.
 *
 * - `state === null` → `unknown` (never connected in this browser).
 * - `wsReadyState !== 1` (WebSocket.OPEN) → `disconnected`.
 * - Otherwise the `state.status` value is mapped to the matching variant;
 *   anything unexpected falls back to `unknown`.
 */
export function deriveDisplayState(state: SessionState | null, wsReadyState: number): DisplayState {
  if (state === null) return UNKNOWN
  if (wsReadyState !== 1) return DISCONNECTED

  // Widen to string so forward-compatible statuses ('error', 'archived')
  // can be matched today even though the narrow `SessionStatus` union
  // doesn't currently include them.
  const status = state.status as string
  switch (status) {
    case 'running':
      return RUNNING
    case 'idle':
      return IDLE
    case 'waiting_gate':
      return WAITING_GATE
    // `SessionState` also carries legacy `waiting_input` / `waiting_permission`
    // variants — treat them as gate-style "needs attention" for display.
    case 'waiting_input':
    case 'waiting_permission':
      return WAITING_GATE
    case 'error':
      return ERROR
    case 'archived':
      return ARCHIVED
    default:
      return UNKNOWN
  }
}

// Exported for tests / advanced consumers that want to reference the
// canonical variant objects without constructing them inline.
export const DISPLAY_STATES = {
  running: RUNNING,
  idle: IDLE,
  waiting_gate: WAITING_GATE,
  error: ERROR,
  archived: ARCHIVED,
  disconnected: DISCONNECTED,
  unknown: UNKNOWN,
} as const
