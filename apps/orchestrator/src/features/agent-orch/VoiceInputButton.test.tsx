/**
 * @vitest-environment jsdom
 *
 * VoiceInputButton tests — Phase 1 of A.5 voice input.
 * Exercises:
 *   - Hidden when SpeechRecognition is unavailable (unsupported browser).
 *   - Hidden when the `enabled` preference is false.
 *   - Final transcript forwarded verbatim to `onFinalTranscript`.
 *   - Interim results forwarded to `onInterimTranscript` (when provided).
 *   - Error events surface via `onError`.
 */

import { VoiceInputButton } from '@duraclaw/ai-elements'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type ResultItem = { transcript: string }
type ResultList = Array<ResultItem> & { isFinal: boolean; length: number }

interface FakeEvent {
  results: ArrayLike<ResultList>
  resultIndex: number
}

interface FakeSpeechRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: FakeEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
  emitInterim(text: string): void
  emitFinal(text: string): void
  emitError(error: string): void
}

const recognitionState: { lastInstance: FakeSpeechRecognition | null } = {
  lastInstance: null,
}

function FakeSpeechRecognitionCtor(this: FakeSpeechRecognition) {
  this.continuous = false
  this.interimResults = false
  this.lang = 'en-US'
  this.onresult = null
  this.onerror = null
  this.onend = null
  this.start = () => {}
  this.stop = () => {
    this.onend?.()
  }
  this.abort = () => {}
  const emit = (text: string, isFinal: boolean) => {
    const item: ResultItem = { transcript: text }
    const list = [item] as unknown as ResultList
    ;(list as unknown as { isFinal: boolean }).isFinal = isFinal
    ;(list as unknown as { length: number }).length = 1
    this.onresult?.({ results: [list], resultIndex: 0 } as FakeEvent)
  }
  this.emitInterim = (text: string) => emit(text, false)
  this.emitFinal = (text: string) => emit(text, true)
  this.emitError = (error: string) => this.onerror?.({ error })
  recognitionState.lastInstance = this
}

afterEach(() => {
  cleanup()
  recognitionState.lastInstance = null
  delete (globalThis as any).SpeechRecognition
  delete (globalThis as any).webkitSpeechRecognition
})

describe('VoiceInputButton', () => {
  it('renders nothing when SpeechRecognition is unavailable', () => {
    const { container } = render(<VoiceInputButton onFinalTranscript={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when enabled=false even if the API is present', () => {
    ;(globalThis as any).SpeechRecognition = FakeSpeechRecognitionCtor
    const { container } = render(<VoiceInputButton enabled={false} onFinalTranscript={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('forwards final transcript to onFinalTranscript on click + emit', () => {
    ;(globalThis as any).SpeechRecognition = FakeSpeechRecognitionCtor
    const onFinal = vi.fn()
    render(<VoiceInputButton onFinalTranscript={onFinal} />)
    const button = screen.getByRole('button', { name: /start dictation/i })
    fireEvent.click(button)
    expect(recognitionState.lastInstance).not.toBeNull()
    act(() => {
      recognitionState.lastInstance?.emitFinal('hello world')
    })
    expect(onFinal).toHaveBeenCalledWith('hello world')
  })

  it('forwards interim results to onInterimTranscript when provided', () => {
    ;(globalThis as any).SpeechRecognition = FakeSpeechRecognitionCtor
    const onFinal = vi.fn()
    const onInterim = vi.fn()
    render(<VoiceInputButton onFinalTranscript={onFinal} onInterimTranscript={onInterim} />)
    fireEvent.click(screen.getByRole('button', { name: /start dictation/i }))
    act(() => {
      recognitionState.lastInstance?.emitInterim('hel')
      recognitionState.lastInstance?.emitInterim('hell')
    })
    expect(onInterim).toHaveBeenCalledWith('hel')
    expect(onInterim).toHaveBeenCalledWith('hell')
    expect(onFinal).not.toHaveBeenCalled()
  })

  it('surfaces errors via onError', () => {
    ;(globalThis as any).SpeechRecognition = FakeSpeechRecognitionCtor
    const onError = vi.fn()
    render(<VoiceInputButton onFinalTranscript={() => {}} onError={onError} />)
    fireEvent.click(screen.getByRole('button', { name: /start dictation/i }))
    act(() => {
      recognitionState.lastInstance?.emitError('no-speech')
    })
    expect(onError).toHaveBeenCalledWith('no-speech')
  })
})
