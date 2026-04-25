/**
 * @vitest-environment jsdom
 *
 * MessageInput tests — verifies compound PromptInput structure with PromptInputBody.
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Shared mock text state the controller hook reads from. Tests can
// mutate this before render to simulate a non-empty draft.
const mockControllerState = { value: '' }

// Shared mock collab state — tests can flip `status` to simulate a WS
// reconnect and inspect the `yText` prop that MessageInput forwards to
// PromptInputTextarea. Using a module-scoped object keeps re-renders
// cheap and avoids re-wiring vi.mock() per case.
const mockCollabState: {
  status: 'connecting' | 'connected' | 'disconnected' | 'auth-failed'
} = { status: 'connecting' }

// Captures the yText prop on every PromptInputTextarea render so we can
// assert that a yText binding stays live across status transitions.
const capturedYTextProps: Array<unknown> = []

// Mock ai-elements to verify compound structure
vi.mock('@duraclaw/ai-elements', () => ({
  PromptInput: ({ children, className, onPaste, ...props }: Record<string, unknown>) => (
    <form
      data-testid="prompt-input"
      data-classname={className as string}
      data-has-onpaste={onPaste ? 'true' : 'false'}
      {...(props as Record<string, unknown>)}
    >
      {children as React.ReactNode}
    </form>
  ),
  PromptInputBody: ({ children }: Record<string, unknown>) => (
    <div data-testid="prompt-input-body">{children as React.ReactNode}</div>
  ),
  PromptInputFooter: ({ children }: Record<string, unknown>) => (
    <div data-testid="prompt-input-footer">{children as React.ReactNode}</div>
  ),
  PromptInputProvider: ({ children }: Record<string, unknown>) => (
    <div data-testid="prompt-input-provider">{children as React.ReactNode}</div>
  ),
  PromptInputSubmit: ({
    disabled,
    status,
    onStop,
    children,
    title,
    className,
    ...rest
  }: Record<string, unknown>) => (
    <button
      type="submit"
      data-testid="prompt-input-submit"
      data-status={(status as string) ?? ''}
      data-has-onstop={onStop ? 'true' : 'false'}
      data-classname={className as string}
      title={title as string}
      aria-label={status === 'streaming' ? 'Stop' : 'Submit'}
      disabled={disabled as boolean}
      onClick={(e) => {
        if (onStop) {
          e.preventDefault()
          ;(onStop as () => void)()
        }
      }}
      // Forward any extra data-* props so tests can assert on
      // data-force-stop / etc.
      {...(rest as Record<string, unknown>)}
    >
      {children as React.ReactNode}
    </button>
  ),
  PromptInputTextarea: ({ placeholder, disabled, yText }: Record<string, unknown>) => {
    capturedYTextProps.push(yText)
    return (
      <textarea
        data-testid="prompt-input-textarea"
        placeholder={placeholder as string}
        disabled={disabled as boolean}
        data-has-ytext={yText ? 'true' : 'false'}
      />
    )
  },
  usePromptInputController: () => ({
    textInput: {
      value: mockControllerState.value,
      setInput: (v: string) => {
        mockControllerState.value = v
      },
      clear: () => {
        mockControllerState.value = ''
      },
    },
  }),
}))

// Stub the collab hook — MessageInput's behavior is orthogonal to the
// collab wiring at the unit level. With no sessionId prop the hook's
// return is ignored at render time, but we still need the import to
// resolve without making a real WS connection.
// Stable Y.Text-ish stub — identity must not change across status flips
// so we can assert the prop `yText` remains the same reference across
// reconnects (rather than flipping to undefined).
const mockYText = {
  toString: () => '',
  insert: () => {},
  delete: () => {},
  observe: () => {},
  unobserve: () => {},
  length: 0,
  doc: null,
}

vi.mock('~/hooks/use-session-collab', () => ({
  useSessionCollab: () => ({
    doc: { destroy: () => {} },
    provider: null,
    get status() {
      return mockCollabState.status
    },
    ytext: mockYText,
    awareness: null,
    selfClientId: null,
    notifyTyping: () => {},
    setCursor: () => {},
  }),
}))

import { MessageInput } from './MessageInput'

afterEach(() => {
  cleanup()
  mockControllerState.value = ''
  mockCollabState.status = 'connecting'
  capturedYTextProps.length = 0
})

describe('MessageInput compound structure', () => {
  it('renders PromptInput as the root element', () => {
    render(<MessageInput onSend={vi.fn()} />)
    const promptInput = screen.getByTestId('prompt-input')
    expect(promptInput).toBeTruthy()
  })

  it('wraps textarea in PromptInputBody', () => {
    render(<MessageInput onSend={vi.fn()} />)
    const body = screen.getByTestId('prompt-input-body')
    expect(body).toBeTruthy()
    const textarea = screen.getByTestId('prompt-input-textarea')
    expect(body.contains(textarea)).toBe(true)
  })

  it('renders PromptInputFooter with submit button and image upload', () => {
    render(<MessageInput onSend={vi.fn()} />)
    const footer = screen.getByTestId('prompt-input-footer')
    expect(footer).toBeTruthy()
    expect(footer.contains(screen.getByTestId('prompt-input-submit'))).toBe(true)
    expect(footer.contains(screen.getByLabelText('Attach image'))).toBe(true)
  })

  it('has onPaste on the PromptInput wrapper', () => {
    render(<MessageInput onSend={vi.fn()} />)
    const promptInput = screen.getByTestId('prompt-input')
    expect(promptInput.getAttribute('data-has-onpaste')).toBe('true')
  })

  it('shows disabled placeholder when disabled', () => {
    render(<MessageInput onSend={vi.fn()} disabled />)
    const textarea = screen.getByTestId('prompt-input-textarea')
    expect(textarea.getAttribute('placeholder')).toBe('Session is not running')
  })

  it('shows active placeholder when not disabled', () => {
    render(<MessageInput onSend={vi.fn()} />)
    const textarea = screen.getByTestId('prompt-input-textarea')
    expect(textarea.getAttribute('placeholder')).toBe('Send a message...')
  })

  it('disables submit button when disabled prop is true', () => {
    render(<MessageInput onSend={vi.fn()} disabled />)
    const submit = screen.getByTestId('prompt-input-submit')
    expect(submit.hasAttribute('disabled')).toBe(true)
  })
})

describe('MessageInput combined send/interrupt button', () => {
  it('shows interrupt mode + fires onInterrupt when running with an empty draft', () => {
    const onInterrupt = vi.fn()
    render(<MessageInput onSend={vi.fn()} status="running" onInterrupt={onInterrupt} />)
    const submit = screen.getByTestId('prompt-input-submit')
    expect(submit.getAttribute('data-status')).toBe('streaming')
    expect(submit.getAttribute('data-has-onstop')).toBe('true')
    expect(submit.getAttribute('aria-label')).toBe('Stop')
    submit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onInterrupt).toHaveBeenCalled()
  })

  it('switches back to send mode when the draft has text (steering path)', () => {
    mockControllerState.value = 'please also add tests'
    const onInterrupt = vi.fn()
    render(<MessageInput onSend={vi.fn()} status="running" onInterrupt={onInterrupt} />)
    const submit = screen.getByTestId('prompt-input-submit')
    expect(submit.getAttribute('data-status')).toBe('')
    expect(submit.getAttribute('data-has-onstop')).toBe('false')
    expect(submit.getAttribute('aria-label')).toBe('Submit')
  })

  it('hides the interrupt affordance when the session is idle', () => {
    render(<MessageInput onSend={vi.fn()} status="idle" onInterrupt={vi.fn()} />)
    const submit = screen.getByTestId('prompt-input-submit')
    expect(submit.getAttribute('data-status')).toBe('')
    expect(submit.getAttribute('data-has-onstop')).toBe('false')
  })

  it('treats waiting_gate like running for the interrupt button', () => {
    const onInterrupt = vi.fn()
    render(
      <MessageInput onSend={vi.fn()} disabled status="waiting_gate" onInterrupt={onInterrupt} />,
    )
    const submit = screen.getByTestId('prompt-input-submit')
    expect(submit.getAttribute('data-status')).toBe('streaming')
    // Interrupt must remain clickable even though `disabled` is true for
    // the composer — users should always be able to halt a runaway turn.
    expect(submit.hasAttribute('disabled')).toBe(false)
  })
})

describe('MessageInput force-stop escalation (state-driven relabel)', () => {
  /**
   * The composer relabels the interrupt button to "Force stop" when a
   * previously fired `interrupt` hasn't settled within the relabel window
   * (see FORCE_STOP_RELABEL_MS in MessageInput.tsx, default 3s). Tests
   * drive a fake timer past the threshold so we don't sleep.
   */
  it('does NOT show force-stop on first click — only interrupt fires', () => {
    const onInterrupt = vi.fn()
    const onForceStop = vi.fn()
    render(
      <MessageInput
        onSend={vi.fn()}
        status="running"
        onInterrupt={onInterrupt}
        onForceStop={onForceStop}
      />,
    )
    const submit = screen.getByTestId('prompt-input-submit')
    expect(submit.getAttribute('data-force-stop')).toBeNull()

    submit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onInterrupt).toHaveBeenCalledTimes(1)
    expect(onForceStop).not.toHaveBeenCalled()
  })

  it('relabels to force-stop after the window elapses while status stays busy', () => {
    vi.useFakeTimers()
    try {
      const onInterrupt = vi.fn()
      const onForceStop = vi.fn()
      render(
        <MessageInput
          onSend={vi.fn()}
          status="running"
          onInterrupt={onInterrupt}
          onForceStop={onForceStop}
        />,
      )
      const submit = screen.getByTestId('prompt-input-submit')

      // First click sends the interrupt.
      act(() => {
        submit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      expect(onInterrupt).toHaveBeenCalledTimes(1)
      expect(submit.getAttribute('data-force-stop')).toBeNull()

      // Drive the relabel timer past the threshold.
      act(() => {
        vi.advanceTimersByTime(3_001)
      })

      // Now the button should carry the force-stop affordance.
      expect(submit.getAttribute('data-force-stop')).toBe('true')
      expect(submit.getAttribute('title')).toMatch(/Force stop/i)

      // Second click fires onForceStop, not onInterrupt again.
      act(() => {
        submit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      expect(onForceStop).toHaveBeenCalledTimes(1)
      expect(onInterrupt).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the relabel timer running when status flickers off mid-window (sticky escalation)', () => {
    // Pre-fix: this test asserted the OPPOSITE — that an `idle` status
    // flip cancelled the relabel timer. That codified the bug: the
    // moment `interrupt()` cleared a pending gate part, useDerivedStatus
    // dropped out of `waiting_gate` (~150ms after click) and the
    // cleanup useEffect tore down `interruptSentAt` before the relabel
    // setTimeout ever fired. Result: the user could never reach the
    // force-stop button on a wedged session. The fix makes the
    // post-click window sticky for FORCE_STOP_WINDOW_MS regardless of
    // status flicker, so the relabel always gets to run.
    vi.useFakeTimers()
    try {
      const onInterrupt = vi.fn()
      const onForceStop = vi.fn()
      const { rerender } = render(
        <MessageInput
          onSend={vi.fn()}
          status="running"
          onInterrupt={onInterrupt}
          onForceStop={onForceStop}
        />,
      )
      const submit = screen.getByTestId('prompt-input-submit')

      act(() => {
        submit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      // Status flips back to idle right after the click — exactly the
      // mid-flight transition that used to cancel the relabel.
      rerender(
        <MessageInput
          onSend={vi.fn()}
          status="idle"
          onInterrupt={onInterrupt}
          onForceStop={onForceStop}
        />,
      )

      // Cross the relabel threshold. Button must still be present
      // AND carry the force-stop affordance because the sticky window
      // outlasts the status flip.
      act(() => {
        vi.advanceTimersByTime(3_001)
      })
      expect(submit.getAttribute('data-status')).toBe('streaming')
      expect(submit.getAttribute('data-force-stop')).toBe('true')
      expect(submit.getAttribute('title')).toMatch(/Force stop/i)

      // Past the full window the button auto-hides — a successful
      // interrupt eventually produces a clean idle composer.
      act(() => {
        vi.advanceTimersByTime(3_001)
      })
      expect(submit.getAttribute('data-status')).toBe('')
      expect(submit.getAttribute('data-force-stop')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders the Stop button when hasPendingGate is true even with status=idle (wedged-from-idle)', () => {
    // Wedged-from-idle: runner died with a `tool-AskUserQuestion`
    // still `input-available`, D1 status flipped to `idle`, but the
    // gate part is still on screen. AgentDetailView passes
    // hasPendingGate=true via useDerivedGate so the user can dismiss
    // the stuck modal from the composer instead of being trapped.
    const onInterrupt = vi.fn()
    render(<MessageInput onSend={vi.fn()} status="idle" hasPendingGate onInterrupt={onInterrupt} />)
    const submit = screen.getByTestId('prompt-input-submit')
    expect(submit.getAttribute('data-status')).toBe('streaming')
    expect(submit.getAttribute('data-has-onstop')).toBe('true')
    expect(submit.getAttribute('aria-label')).toBe('Stop')

    submit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it('escalates to force-stop on a wedged-from-idle gate after the relabel window', () => {
    // Same wedged-from-idle case, plus the user click + 3s wait. This
    // is the canonical "Stop button does nothing, please give me a
    // bigger hammer" flow the fix exists for.
    vi.useFakeTimers()
    try {
      const onInterrupt = vi.fn()
      const onForceStop = vi.fn()
      render(
        <MessageInput
          onSend={vi.fn()}
          status="idle"
          hasPendingGate
          onInterrupt={onInterrupt}
          onForceStop={onForceStop}
        />,
      )
      const submit = screen.getByTestId('prompt-input-submit')

      act(() => {
        submit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      expect(onInterrupt).toHaveBeenCalledTimes(1)

      act(() => {
        vi.advanceTimersByTime(3_001)
      })
      expect(submit.getAttribute('data-force-stop')).toBe('true')

      act(() => {
        submit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      expect(onForceStop).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MessageInput draft stability across collab status transitions', () => {
  it('keeps yText bound while collab status cycles through disconnected/connecting', () => {
    // Render with a sessionId so collabActive=true. Status starts as 'connected'.
    mockCollabState.status = 'connected'
    capturedYTextProps.length = 0

    const { rerender } = render(<MessageInput onSend={vi.fn()} sessionId="test-session" />)

    // Baseline: yText should be bound (truthy) when connected.
    const initialYText = capturedYTextProps[capturedYTextProps.length - 1]
    expect(initialYText).toBeTruthy()

    // Simulate WS disconnect (deploy / reconnect).
    mockCollabState.status = 'disconnected'
    capturedYTextProps.length = 0
    rerender(<MessageInput onSend={vi.fn()} sessionId="test-session" />)
    const disconnectedYText = capturedYTextProps[capturedYTextProps.length - 1]
    expect(disconnectedYText).toBeTruthy()
    expect(disconnectedYText).toBe(initialYText) // same Y.Text reference

    // Simulate reconnecting phase.
    mockCollabState.status = 'connecting'
    capturedYTextProps.length = 0
    rerender(<MessageInput onSend={vi.fn()} sessionId="test-session" />)
    const connectingYText = capturedYTextProps[capturedYTextProps.length - 1]
    expect(connectingYText).toBeTruthy()
    expect(connectingYText).toBe(initialYText)

    // Back to connected — still the same reference.
    mockCollabState.status = 'connected'
    capturedYTextProps.length = 0
    rerender(<MessageInput onSend={vi.fn()} sessionId="test-session" />)
    const reconnectedYText = capturedYTextProps[capturedYTextProps.length - 1]
    expect(reconnectedYText).toBeTruthy()
    expect(reconnectedYText).toBe(initialYText)
  })

  it('does not bind yText when no sessionId is provided (legacy/standalone mode)', () => {
    mockCollabState.status = 'connected'
    capturedYTextProps.length = 0

    render(<MessageInput onSend={vi.fn()} />)
    const yTextProp = capturedYTextProps[capturedYTextProps.length - 1]
    // collabActive is false (no sessionId), so yText should be undefined.
    expect(yTextProp).toBeFalsy()
  })
})
