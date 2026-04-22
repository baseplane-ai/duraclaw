/**
 * DisconnectedBanner — renders above StatusBar when the session WS is
 * disconnected but the session has an sdk_session_id (i.e. there's an
 * on-disk JSONL transcript to resume from). Auto-retries once on mount;
 * shows manual Retry / Resume buttons if auto-retry doesn't reconnect
 * within a few seconds.
 */

import { WifiOffIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionLocalState } from '~/db/session-local-collection'
import { useSession } from '~/hooks/use-sessions-collection'
import { deriveStatus } from '~/lib/derive-status'
import { useNow } from '~/lib/use-now'
import { cn } from '~/lib/utils'

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
  const status = session ? deriveStatus(session, nowTs) : 'idle'
  const hasSdkSession = Boolean(session?.sdkSessionId)

  // Banner visibility: WS is not open, session is not actively streaming
  // (idle), and there's an sdk_session_id to resume to.
  const isDisconnected = wsReadyState !== 1
  const isRecoverable = status === 'idle'
  const shouldShow = isDisconnected && isRecoverable && hasSdkSession

  // Auto-retry: attempt reattach once on mount with a 3s delay.
  // If the WS reconnects before the timer fires, the banner disappears
  // (shouldShow goes false) and we never fire the RPC.
  const [autoRetried, setAutoRetried] = useState(false)
  const [busy, setBusy] = useState(false)
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountSessionIdRef = useRef(sessionId)

  // Reset auto-retry state when sessionId changes (tab switch).
  if (mountSessionIdRef.current !== sessionId) {
    mountSessionIdRef.current = sessionId
    setAutoRetried(false)
    setBusy(false)
  }

  useEffect(() => {
    if (!shouldShow || autoRetried) return

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
    }, 3000)

    return () => {
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current)
        autoRetryTimerRef.current = null
      }
    }
  }, [shouldShow, autoRetried, onReattach])

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
