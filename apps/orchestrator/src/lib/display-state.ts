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
  // Spec #80 P1: `pending` = runner stamped, pre-first-event. Existing
  // used colors are green (running), gray (idle/archived/disconnected/
  // unknown), amber (waiting_gate). Spec preference order is
  // amber → violet → sky; amber is taken, so violet is first unused.
  | {
      status: 'pending'
      label: 'Thinking'
      color: 'violet'
      icon: 'spinner'
      isInteractive: true
    }
  | { status: 'idle'; label: 'Idle'; color: 'gray'; icon: 'circle'; isInteractive: true }
  // Tab-scoped derived state: the session has reached `idle` (a turn
  // completed) but the user has not activated this tab since. Flipped on
  // by `deriveTabDisplayState` when `session.messageSeq > tab.lastSeenSeq`
  // and cleared the moment the tab becomes active (see
  // `use-tab-sync.setActive` / the mark-seen effect in `tab-bar.tsx`).
  // Sky is the next color in the spec-#80 preference order
  // (amber → violet → sky) and is otherwise unused.
  | {
      status: 'completed_unseen'
      label: 'Done'
      color: 'sky'
      icon: 'check'
      isInteractive: true
    }
  | {
      status: 'waiting_gate'
      label: 'Needs Attention'
      color: 'amber'
      icon: 'alert'
      isInteractive: true
    }
  | { status: 'error'; label: 'Error'; color: 'red'; icon: 'alert'; isInteractive: true }
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

const PENDING: DisplayState = {
  status: 'pending',
  label: 'Thinking',
  color: 'violet',
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

const COMPLETED_UNSEEN: DisplayState = {
  status: 'completed_unseen',
  label: 'Done',
  color: 'sky',
  icon: 'check',
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
    // `pending` (runner stamped, pre-first-event) collapses into the
    // RUNNING display so the StatusBar / tab / list badge shows a single
    // "Running" state across the entire in-flight turn. The inline
    // `AwaitingBubble` in the thread already distinguishes the
    // pre-first-token phase; the chrome surfaces don't need a second
    // "Thinking" indicator that flickers off on the first delta (and lags
    // D1 either direction). External-wait reasons (subagent / task /
    // monitor) are the remaining StatusBar-worthy signals — they're not
    // yet emitted, so `pending` folding into `running` is the full
    // StatusBar surface for now.
    case 'pending':
      return RUNNING
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
  pending: PENDING,
  idle: IDLE,
  completed_unseen: COMPLETED_UNSEEN,
  waiting_gate: WAITING_GATE,
  error: ERROR,
  archived: ARCHIVED,
  disconnected: DISCONNECTED,
  unknown: UNKNOWN,
} as const

/**
 * Tab-scoped display-state derivation. Upgrades the base server status
 * (`deriveDisplayStateFromStatus`) to `completed_unseen` when all of these
 * hold:
 *
 *   - The base-derived state is `idle` — i.e. server says the session's
 *     current turn has wrapped. We deliberately don't promote from
 *     `running` / `pending` / `waiting_gate` / `error`: those already draw
 *     the user's eye via their own colors and upgrading them to "Done"
 *     would be a lie.
 *   - The tab is NOT the currently-active tab — if the user is looking
 *     at it, it can't be unseen.
 *   - `sessionMessageSeq > lastSeenSeq`. `messageSeq` is D1-mirrored from
 *     the SessionDO's broadcast envelope counter (bumped on every event
 *     frame). `lastSeenSeq` is stamped by the mark-seen effect on tab
 *     activation / status transition. Strict `>` so freshly-seeded tabs
 *     (equal values) don't spuriously show "Done".
 *
 * When any condition is false, returns the base state unchanged. Intended
 * to be called per-tab from the tab strip — the sidebar / status-bar
 * deliberately stay on the unadorned server status since they aren't
 * tab-scoped.
 */
export function deriveTabDisplayState(args: {
  status: SessionStatus | undefined
  wsReadyState: number
  wsCloseTs?: number | null
  nowTs?: number
  isActive: boolean
  sessionMessageSeq: number | undefined
  lastSeenSeq: number | undefined
}): DisplayState {
  const base = deriveDisplayStateFromStatus(
    args.status,
    args.wsReadyState,
    args.wsCloseTs ?? null,
    args.nowTs ?? Date.now(),
  )
  if (base.status !== 'idle') return base
  if (args.isActive) return base
  const sessionSeq = args.sessionMessageSeq ?? -1
  const lastSeen = args.lastSeenSeq ?? -1
  if (sessionSeq > lastSeen) return COMPLETED_UNSEEN
  return base
}
