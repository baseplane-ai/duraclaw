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

  it('renders heading, chips, and textarea', () => {
    render(<QuickPromptInput onSubmit={vi.fn()} projects={mockProjects} />)

    expect(screen.getByText('What should the agent do?')).toBeDefined()
    expect(screen.getByText('duraclaw')).toBeDefined()
    expect(screen.getByText('claude-opus-4-6')).toBeDefined()
    expect(screen.getByPlaceholderText('Type a prompt and press Enter...')).toBeDefined()
  })

  it('pressing Enter calls onSubmit with correct config', () => {
    const onSubmit = vi.fn()
    render(<QuickPromptInput onSubmit={onSubmit} projects={mockProjects} />)

    const textarea = screen.getByPlaceholderText('Type a prompt and press Enter...')
    fireEvent.change(textarea, { target: { value: 'Fix the bug' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(onSubmit).toHaveBeenCalledWith({
      project: 'duraclaw',
      model: 'claude-opus-4-6',
      agent: 'claude',
      prompt: 'Fix the bug',
    })
  })

  it('clicking project chip cycles through projects', () => {
    render(<QuickPromptInput onSubmit={vi.fn()} projects={mockProjects} />)

    const projectChip = screen.getByText('duraclaw')
    expect(projectChip).toBeDefined()

    fireEvent.click(projectChip)
    expect(screen.getByText('baseplane')).toBeDefined()

    fireEvent.click(screen.getByText('baseplane'))
    expect(screen.getByText('other-project')).toBeDefined()

    // Wraps around
    fireEvent.click(screen.getByText('other-project'))
    expect(screen.getByText('duraclaw')).toBeDefined()
  })

  it('clicking model chip cycles through models', () => {
    render(<QuickPromptInput onSubmit={vi.fn()} projects={mockProjects} />)

    const modelChip = screen.getByText('claude-opus-4-6')
    fireEvent.click(modelChip)
    expect(screen.getByText('claude-sonnet-4-6')).toBeDefined()

    fireEvent.click(screen.getByText('claude-sonnet-4-6'))
    expect(screen.getByText('claude-sonnet-4-5')).toBeDefined()

    fireEvent.click(screen.getByText('claude-sonnet-4-5'))
    expect(screen.getByText('codex — gpt-5.4')).toBeDefined()
  })

  it('Shift+Enter does not submit', () => {
    const onSubmit = vi.fn()
    render(<QuickPromptInput onSubmit={onSubmit} projects={mockProjects} />)

    const textarea = screen.getByPlaceholderText('Type a prompt and press Enter...')
    fireEvent.change(textarea, { target: { value: 'Some prompt' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onSubmit).not.toHaveBeenCalled()
  })
})
