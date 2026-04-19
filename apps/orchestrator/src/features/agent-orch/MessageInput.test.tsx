/**
 * @vitest-environment jsdom
 *
 * MessageInput tests — verifies compound PromptInput structure with PromptInputBody.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Shared mock text state the controller hook reads from. Tests can
// mutate this before render to simulate a non-empty draft.
const mockControllerState = { value: '' }

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
  PromptInputSubmit: ({ disabled, status, onStop, children }: Record<string, unknown>) => (
    <button
      type="submit"
      data-testid="prompt-input-submit"
      data-status={(status as string) ?? ''}
      data-has-onstop={onStop ? 'true' : 'false'}
      aria-label={status === 'streaming' ? 'Stop' : 'Submit'}
      disabled={disabled as boolean}
      onClick={(e) => {
        if (onStop) {
          e.preventDefault()
          ;(onStop as () => void)()
        }
      }}
    >
      {children as React.ReactNode}
    </button>
  ),
  PromptInputTextarea: ({ placeholder, disabled }: Record<string, unknown>) => (
    <textarea
      data-testid="prompt-input-textarea"
      placeholder={placeholder as string}
      disabled={disabled as boolean}
    />
  ),
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
vi.mock('~/hooks/use-session-collab', () => ({
  useSessionCollab: () => ({
    doc: { destroy: () => {} },
    provider: null,
    status: 'connecting',
    ytext: {
      toString: () => '',
      insert: () => {},
      delete: () => {},
      observe: () => {},
      unobserve: () => {},
      length: 0,
      doc: null,
    },
    awareness: null,
    selfClientId: null,
    notifyTyping: () => {},
  }),
}))

import { MessageInput } from './MessageInput'

afterEach(() => {
  cleanup()
  mockControllerState.value = ''
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
