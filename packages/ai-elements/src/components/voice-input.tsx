'use client'

/**
 * VoiceInputButton — Web Speech API mic button for dictating into a text
 * field. Phase 1 of A.5 (voice input).
 *
 * Contract (see planning/specs/20-voice-input.md):
 * - Draft-only: final transcript is returned to the caller via
 *   `onFinalTranscript`; the button NEVER auto-sends.
 * - Surfaces live interim text via `onInterimTranscript` so the caller can
 *   render a subtle in-flight hint.
 * - Hidden (returns null) on browsers without SpeechRecognition — the
 *   surrounding composer MUST keep working without it.
 * - Requires the user to activate it each time (click to toggle on desktop,
 *   press-and-hold on touch). No silent always-on listening.
 */

import { MicIcon, MicOffIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/utils'
import { Button } from '../ui/button'

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

interface SpeechRecognitionResultEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean; length: number }>
  resultIndex: number
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface VoiceInputButtonProps
  extends Omit<ComponentProps<typeof Button>, 'onClick' | 'onError' | 'children'> {
  /**
   * Called once per finalised utterance. Caller is responsible for
   * appending to the draft (or gate answer). Never auto-sends.
   */
  onFinalTranscript: (transcript: string) => void
  /**
   * Optional live interim callback. Fires on each non-final result. Useful
   * for rendering an inline "hearing you..." hint.
   */
  onInterimTranscript?: (transcript: string) => void
  /**
   * Called when the recogniser errors. The button resets itself to idle
   * regardless; the caller may surface a toast.
   */
  onError?: (error: string) => void
  /** BCP-47 language tag. Phase 1 ships English-only; enum lands with Phase 2. */
  lang?: string
  /** Feature flag from `user_preferences.voice_input_enabled`. */
  enabled?: boolean
}

export function VoiceInputButton({
  onFinalTranscript,
  onInterimTranscript,
  onError,
  lang = 'en-US',
  enabled = true,
  className,
  disabled,
  ...buttonProps
}: VoiceInputButtonProps) {
  // Resolve the ctor fresh on every render so test-time globals take
  // effect without requiring a useEffect round-trip. SSR-safe because
  // `getSpeechRecognitionCtor` guards on `typeof window`.
  const ctor = getSpeechRecognitionCtor()
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)

  const stop = useCallback(() => {
    const rec = recognitionRef.current
    if (rec) {
      try {
        rec.stop()
      } catch {
        // already stopped — idempotent
      }
    }
  }, [])

  const start = useCallback(() => {
    if (!ctor) return
    // Defensive: if a previous recogniser is still running, tear it down
    // before starting a new one.
    stop()

    const rec = new ctor()
    rec.continuous = false
    rec.interimResults = true
    rec.lang = lang

    rec.onresult = (event) => {
      let interim = ''
      let finalText = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) {
          finalText += text
        } else {
          interim += text
        }
      }
      if (interim && onInterimTranscript) {
        onInterimTranscript(interim)
      }
      const trimmed = finalText.trim()
      if (trimmed) {
        onFinalTranscript(trimmed)
      }
    }

    rec.onerror = (event) => {
      onError?.(event.error)
    }

    rec.onend = () => {
      setListening(false)
      recognitionRef.current = null
    }

    recognitionRef.current = rec
    try {
      rec.start()
      setListening(true)
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Failed to start recognition')
      setListening(false)
      recognitionRef.current = null
    }
  }, [ctor, lang, onFinalTranscript, onInterimTranscript, onError, stop])

  // Cleanup on unmount so we never leak a live mic stream.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort()
    }
  }, [])

  if (!enabled || !ctor) return null

  const toggle = () => {
    if (listening) {
      stop()
    } else {
      start()
    }
  }

  return (
    <Button
      type="button"
      variant={listening ? 'default' : 'ghost'}
      size="icon"
      aria-label={listening ? 'Stop dictation' : 'Start dictation'}
      aria-pressed={listening}
      onClick={toggle}
      disabled={disabled}
      className={cn('size-7', listening && 'animate-pulse text-primary-foreground', className)}
      {...buttonProps}
    >
      {listening ? <MicOffIcon className="size-4" /> : <MicIcon className="size-4" />}
    </Button>
  )
}
