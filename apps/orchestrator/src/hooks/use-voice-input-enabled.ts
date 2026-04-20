/**
 * useVoiceInputEnabled — single-bit preference hook for A.5 Phase 1.
 *
 * Resolution order on mount:
 *   1. Server value (`GET /api/preferences`, column `voiceInputEnabled`).
 *   2. If server returns `null`, fall back to first-run logic: `true`
 *      when `window.SpeechRecognition` (or vendor-prefixed) exists,
 *      `false` otherwise. First-run default is persisted back to the
 *      server so both tabs / devices agree.
 *
 * The hook returns:
 *   { enabled, setEnabled }
 *
 * `enabled` is always a concrete boolean by the time the UI can render
 * the mic button — we optimistically fall back to browser-support while
 * the fetch is in-flight so we never render a flicker.
 */

import { useCallback, useEffect, useState } from 'react'

function browserHasSpeechRecognition(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as {
    SpeechRecognition?: unknown
    webkitSpeechRecognition?: unknown
  }
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition)
}

export function useVoiceInputEnabled() {
  const [enabled, setEnabledState] = useState<boolean>(() => browserHasSpeechRecognition())

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch('/api/preferences')
        if (!resp.ok) return
        const row = (await resp.json()) as { voiceInputEnabled?: boolean | null }
        if (cancelled) return
        if (row.voiceInputEnabled === null || row.voiceInputEnabled === undefined) {
          // First-run: default based on browser support and persist.
          const first = browserHasSpeechRecognition()
          setEnabledState(first)
          await fetch('/api/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voiceInputEnabled: first }),
          }).catch(() => {})
        } else {
          setEnabledState(Boolean(row.voiceInputEnabled))
        }
      } catch {
        // Network errors leave the in-memory default (browser support)
        // — voice input still works locally, server-sync resumes on
        // next preference fetch.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const setEnabled = useCallback(async (next: boolean) => {
    setEnabledState(next)
    try {
      await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceInputEnabled: next }),
      })
    } catch {
      // Swallow — the local state is already flipped. Next refetch
      // will reconcile.
    }
  }, [])

  return { enabled, setEnabled }
}
