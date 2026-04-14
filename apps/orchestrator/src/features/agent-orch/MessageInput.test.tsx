/**
 * @vitest-environment jsdom
 *
 * MessageInput tests — verifies compound PromptInput structure with PromptInputBody.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  PromptInputSubmit: ({ disabled }: Record<string, unknown>) => (
    <button type="submit" data-testid="prompt-input-submit" disabled={disabled as boolean} />
  ),
  PromptInputTextarea: ({ placeholder, disabled }: Record<string, unknown>) => (
    <textarea
      data-testid="prompt-input-textarea"
      placeholder={placeholder as string}
      disabled={disabled as boolean}
    />
  ),
}))

import { MessageInput } from './MessageInput'

afterEach(() => {
  cleanup()
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
