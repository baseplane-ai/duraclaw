/**
 * display-state — Centralized session status-to-UI derivation (B10).
 *
 * Consumed by StatusBar, SessionListItem / SessionCardList (sidebar), and
 * the tab bar so every surface agrees on the label / color / icon /
 * interactivity for a given `SessionStatus` + WS `readyState` pair.
 *
 * Spec #37: every caller reads `status` directly from the `agent_sessions`
 * synced-collection row (via `useSession(sessionId)`) and pairs it with
 * `wsReadyState` from `sessionLocalCollection` (via `useSessionLocalState`).
 * The prior message-derived status path (spec #31) was retired because
 * D1-mirrored status eliminates the ordering-quirk bug class.
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

// GH#69 B5: grace window after a WS close during which we suppress the
// DISCONNECTED label so the ConnectionManager reconnect cycle can finish
// before the UI flashes "Reconnecting…".
const WS_GRACE_MS = 5_000

/**
 * Derive the UI display state for a session given its status and the
 * current WS `readyState`.
 *
 * - `status === undefined` → `unknown` (never connected / no D1 mirror in
 *   this browser).
 * - `wsReadyState !== 1` (WebSocket.OPEN) → `disconnected`, unless
 *   `wsCloseTs` is within the B5 grace window, in which case we fall
 *   through to the server-status-derived path.
 * - Otherwise `status` is mapped to the matching variant; anything
 *   unexpected falls back to `unknown`.
 *
 * `wsCloseTs` + `nowTs` are optional so existing call sites that don't
 * observe WS close timestamps keep today's semantics (immediate
 * DISCONNECTED when `wsReadyState !== 1`).
 */
export function deriveDisplayStateFromStatus(
  status: SessionStatus | undefined,
  wsReadyState: number,
  wsCloseTs: number | null = null,
  nowTs: number = Date.now(),
): DisplayState {
  if (status === undefined) return UNKNOWN
  if (wsReadyState !== 1) {
    // GH#69 B5: suppress DISCONNECTED for 5s after WS close so the
    // ConnectionManager reconnect cycle completes before the UI flashes
    // "Reconnecting…". After the grace expires, fall through to DISCONNECTED.
    // Strict less-than so the 5s boundary itself is DISCONNECTED.
    const withinGrace = wsCloseTs != null && nowTs - wsCloseTs < WS_GRACE_MS
    if (!withinGrace) return DISCONNECTED
    // within grace — fall through to server-status-derived path below
  }

  // Widen to string so forward-compatible statuses ('archived')
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
  archived: ARCHIVED,
  disconnected: DISCONNECTED,
  unknown: UNKNOWN,
} as const
