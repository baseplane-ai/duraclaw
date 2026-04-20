/**
 * display-state — Centralized session status-to-UI derivation (B10).
 *
 * Consumed by StatusBar, SessionListItem / SessionCardList (sidebar), and
 * the tab bar so every surface agrees on the label / color / icon /
 * interactivity for a given `SessionStatus` + WS `readyState` pair.
 *
 * Spec #31 P5: the `SessionState` blob is gone. Callers now pass the
 * session's status directly — active callers derive it from messages via
 * `useDerivedStatus`; sidebar callers read the D1-mirrored `status` on
 * `SessionLiveState`.
 */

import type { SessionStatus } from '~/lib/types'

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
      label: 'Reconnecting…'
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
  label: 'Reconnecting…',
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
 * Derive the UI display state for a session given its status and the
 * current WS `readyState`.
 *
 * - `status === undefined` → `unknown` (never connected / no D1 mirror in
 *   this browser).
 * - `wsReadyState !== 1` (WebSocket.OPEN) → `disconnected`.
 * - Otherwise `status` is mapped to the matching variant; anything
 *   unexpected falls back to `unknown`.
 */
export function deriveDisplayStateFromStatus(
  status: SessionStatus | undefined,
  wsReadyState: number,
): DisplayState {
  if (status === undefined) return UNKNOWN
  if (wsReadyState !== 1) return DISCONNECTED

  // Widen to string so forward-compatible statuses ('error', 'archived')
  // can be matched today even though the narrow `SessionStatus` union
  // doesn't currently include them.
  const s = status as string
  switch (s) {
    case 'running':
      return RUNNING
    case 'idle':
      return IDLE
    case 'waiting_gate':
      return WAITING_GATE
    // Legacy `waiting_input` / `waiting_permission` variants — treat them
    // as gate-style "needs attention" for display.
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
