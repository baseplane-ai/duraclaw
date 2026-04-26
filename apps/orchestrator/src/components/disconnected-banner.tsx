/**
 * DisconnectedBanner — renders above StatusBar when the session WS has
 * been disconnected for more than DISCONNECT_GRACE_MS and the session
 * has a runner_session_id (i.e. there's an on-disk JSONL transcript to
 * resume from). The grace period keeps transient flaps (visibility
 * change, network hiccup, normal ConnectionManager reconnect) from
 * flashing the banner. Auto-retries the gateway dial once the grace
 * elapses; shows manual Retry / Resume buttons if that RPC fails.
 */

import { WifiOffIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionLocalState, useSessionStatus } from '~/db/session-local-collection'
import { useSession } from '~/hooks/use-sessions-collection'
import type { SessionStatus } from '~/lib/types'
import { useNow } from '~/lib/use-now'
import { cn } from '~/lib/utils'

/**
 * How long the WS must stay disconnected before we surface the banner.
 * Tuned to ride out the ConnectionManager's foreground/online reconnect
 * (which schedules with [0, 500) ms stagger) and short network flaps
 * without flashing UI. Also aligns with the auto-reattach timer, so a
 * single user-visible action happens after this window elapses.
 */
const DISCONNECT_GRACE_MS = 3000

interface DisconnectedBannerProps {
  sessionId: string | null
  /** Call the DO's `reattach` RPC — retry the gateway dial. */
  onReattach: () => Promise<unknown>
  /** Call the DO's `resumeFromTranscript` RPC — force-resume from JSONL. */
  onResumeFromTranscript: () => Promise<unknown>
}

export function DisconnectedBanner({
  sessionId,
  onReattach,
  onResumeFromTranscript,
}: DisconnectedBannerProps) {
  const session = useSession(sessionId)
  const local = useSessionLocalState(sessionId)

  const nowTs = useNow()
  const wsReadyState = local?.wsReadyState ?? 3
  const status =
    useSessionStatus(sessionId) ?? (session?.status as SessionStatus | undefined) ?? 'idle'
  const hasRunnerSession = Boolean(session?.runnerSessionId)

  // Baseline: eligible to eventually show if WS is not open, session is
  // not actively streaming (idle), and there's a runner_session_id to
  // resume to. This is the trigger for the grace-period timer — NOT
  // the banner's visibility gate.
  const isDisconnected = wsReadyState !== 1
  const isRecoverable = status === 'idle'
  const isEligible = isDisconnected && isRecoverable && hasRunnerSession

  // Track when the disconnected state started. Cleared the moment the
  // WS comes back or the session becomes non-recoverable, so a brief
  // flap never accumulates toward the grace threshold.
  const disconnectedSinceRef = useRef<number | null>(null)
  if (isEligible) {
    if (disconnectedSinceRef.current === null) {
      disconnectedSinceRef.current = Date.now()
    }
  } else if (disconnectedSinceRef.current !== null) {
    disconnectedSinceRef.current = null
  }

  const disconnectedSince = disconnectedSinceRef.current
  const hasElapsed = disconnectedSince !== null && nowTs - disconnectedSince >= DISCONNECT_GRACE_MS
  const shouldShow = isEligible && hasElapsed

  const [autoRetried, setAutoRetried] = useState(false)
  const [busy, setBusy] = useState(false)
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountSessionIdRef = useRef(sessionId)

  // Reset auto-retry state when sessionId changes (tab switch).
  if (mountSessionIdRef.current !== sessionId) {
    mountSessionIdRef.current = sessionId
    setAutoRetried(false)
    setBusy(false)
    disconnectedSinceRef.current = isEligible ? Date.now() : null
  }

  // Auto-retry: once the grace window elapses, fire reattach once.
  // If the WS reconnects during the window, `isEligible` flips false,
  // the disconnect timestamp resets, and we never fire the RPC.
  useEffect(() => {
    if (!isEligible || autoRetried || disconnectedSince === null) return

    const elapsed = Date.now() - disconnectedSince
    const delay = Math.max(0, DISCONNECT_GRACE_MS - elapsed)

    autoRetryTimerRef.current = setTimeout(async () => {
      setAutoRetried(true)
      setBusy(true)
      try {
        await onReattach()
      } catch {
        // Non-fatal — buttons stay visible for manual retry.
      } finally {
        setBusy(false)
      }
    }, delay)

    return () => {
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current)
        autoRetryTimerRef.current = null
      }
    }
  }, [isEligible, autoRetried, disconnectedSince, onReattach])

  const handleRetry = useCallback(async () => {
    setBusy(true)
    try {
      await onReattach()
    } catch {
      // stay visible
    } finally {
      setBusy(false)
    }
  }, [onReattach])

  const handleResume = useCallback(async () => {
    setBusy(true)
    try {
      await onResumeFromTranscript()
    } catch {
      // stay visible
    } finally {
      setBusy(false)
    }
  }, [onResumeFromTranscript])

  if (!shouldShow) return null

  return (
    <div
      className={cn(
        'flex w-full items-center gap-2 px-2 py-1.5 font-mono text-xs',
        'bg-warning/20 border-t border-warning/50',
      )}
      data-testid="disconnected-banner"
    >
      <WifiOffIcon className="size-3.5 shrink-0 text-warning" />
      <span className="text-foreground">
        {busy ? 'Reconnecting\u2026' : 'Session disconnected'}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={handleRetry}
          className="rounded border border-warning/50 bg-warning/10 px-2 py-0.5 text-foreground hover:bg-warning/20 disabled:opacity-50"
        >
          Retry
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={handleResume}
          className="rounded border border-warning/50 bg-warning/10 px-2 py-0.5 text-foreground hover:bg-warning/20 disabled:opacity-50"
        >
          Resume
        </button>
      </div>
    </div>
  )
}
