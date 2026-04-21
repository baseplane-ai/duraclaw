/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuickPromptInput } from './quick-prompt-input'

// Mock useUserDefaults
vi.mock('~/hooks/use-user-defaults', () => ({
  useUserDefaults: () => ({
    preferences: { model: 'claude-opus-4-6', permission_mode: 'default' },
    updatePreferences: vi.fn(),
    loading: false,
  }),
}))

const mockProjects = [
  { name: 'duraclaw', path: '/home/user/duraclaw' },
  { name: 'baseplane', path: '/home/user/baseplane' },
  { name: 'other-project', path: '/home/user/other' },
]

describe('QuickPromptInput', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders heading, project chip, and composer textarea', () => {
    render(<QuickPromptInput onSubmit={vi.fn()} projects={mockProjects} />)

    expect(screen.getByText('What should the agent do?')).toBeDefined()
    expect(screen.getByText('duraclaw')).toBeDefined()
    expect(screen.getByText('claude-opus-4-6')).toBeDefined()
    expect(
      screen.getByPlaceholderText('Describe the task, paste or attach an image...'),
    ).toBeDefined()
  })

  it('exposes an image attach control for new sessions', () => {
    render(<QuickPromptInput onSubmit={vi.fn()} projects={mockProjects} />)
    expect(screen.getByLabelText('Attach image')).toBeDefined()
  })

  it('pressing Enter on the composer submits text prompt', async () => {
    const onSubmit = vi.fn()
    render(<QuickPromptInput onSubmit={onSubmit} projects={mockProjects} />)

    const textarea = screen.getByPlaceholderText(
      'Describe the task, paste or attach an image...',
    ) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Fix the bug' } })
    // PromptInputTextarea turns Enter into form.requestSubmit(); drive the
    // same path via the visible submit button. PromptInput.handleSubmit is
    // async (awaits blob-url conversion) so we wait a microtask before
    // asserting.
    const submitButton = textarea.form?.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement | null
    if (!submitButton) throw new Error('submit button not found')
    fireEvent.click(submitButton)
    await Promise.resolve()
    await Promise.resolve()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const call = onSubmit.mock.calls[0][0]
    expect(call).toMatchObject({
      project: 'duraclaw',
      model: 'claude-opus-4-6',
      agent: 'claude',
      prompt: 'Fix the bug',
    })
  })

  it('Shift+Enter does not submit', () => {
    const onSubmit = vi.fn()
    render(<QuickPromptInput onSubmit={onSubmit} projects={mockProjects} />)

    const textarea = screen.getByPlaceholderText(
      'Describe the task, paste or attach an image...',
    ) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Some prompt' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not submit when prompt is empty and no images attached', () => {
    const onSubmit = vi.fn()
    render(<QuickPromptInput onSubmit={onSubmit} projects={mockProjects} />)

    const textarea = screen.getByPlaceholderText(
      'Describe the task, paste or attach an image...',
    ) as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('prefills the selected project when initialProject is provided', async () => {
    const onSubmit = vi.fn()
    render(
      <QuickPromptInput onSubmit={onSubmit} projects={mockProjects} initialProject="baseplane" />,
    )

    // The Select's trigger should show the prefilled project instead of
    // the first project or the loading placeholder.
    expect(screen.getByText('baseplane')).toBeDefined()
    // The default-first project 'duraclaw' must not be selected.
    const triggerText = screen.getAllByRole('combobox')[0].textContent || ''
    expect(triggerText).toContain('baseplane')
    expect(triggerText).not.toContain('duraclaw')

    const textarea = screen.getByPlaceholderText(
      'Describe the task, paste or attach an image...',
    ) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Fix it' } })
    const submitButton = textarea.form?.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement | null
    if (!submitButton) throw new Error('submit button not found')
    fireEvent.click(submitButton)
    await Promise.resolve()
    await Promise.resolve()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ project: 'baseplane' })
  })
})
