/**
 * @vitest-environment jsdom
 *
 * GateResolver tests — verifies structured AskUserQuestion rendering and interaction.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GateResolver } from './GateResolver'

afterEach(cleanup)

const sampleGate = {
  id: 'gate-1',
  type: 'ask_user' as const,
  detail: {
    questions: [
      {
        question: 'Which library should we use?',
        header: 'Library',
        options: [
          { label: 'lodash', description: 'General-purpose utility library' },
          { label: 'ramda', description: 'Functional programming library' },
        ],
        multiSelect: false,
      },
    ],
  },
}

const multiSelectGate = {
  id: 'gate-2',
  type: 'ask_user' as const,
  detail: {
    questions: [
      {
        question: 'Which features should we add?',
        header: 'Features',
        options: [
          { label: 'dark-mode', description: 'Dark mode support' },
          { label: 'i18n', description: 'Internationalization' },
          { label: 'analytics', description: 'Usage analytics' },
        ],
        multiSelect: true,
      },
    ],
  },
}

const multiQuestionGate = {
  id: 'gate-3',
  type: 'ask_user' as const,
  detail: {
    questions: [
      {
        question: 'Which library?',
        header: 'Library',
        options: [
          { label: 'lodash', description: 'Utility library' },
          { label: 'ramda', description: 'FP library' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which framework?',
        header: 'Framework',
        options: [
          { label: 'react', description: 'React framework' },
          { label: 'vue', description: 'Vue framework' },
        ],
        multiSelect: false,
      },
    ],
  },
}

describe('GateResolver — structured AskUserQuestion', () => {
  it('renders question text and header chip', () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<GateResolver gate={sampleGate} onResolve={onResolve} />)

    expect(screen.getByText('Which library should we use?')).toBeTruthy()
    expect(screen.getByText('Library')).toBeTruthy()
  })

  it('renders option cards with label and description', () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<GateResolver gate={sampleGate} onResolve={onResolve} />)

    expect(screen.getByText('lodash')).toBeTruthy()
    expect(screen.getByText('General-purpose utility library')).toBeTruthy()
    expect(screen.getByText('ramda')).toBeTruthy()
    expect(screen.getByText('Functional programming library')).toBeTruthy()
  })

  it('clicking an option highlights it and enables Submit', () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<GateResolver gate={sampleGate} onResolve={onResolve} />)

    // Submit should be disabled initially
    const submitBtn = screen.getByRole('button', { name: /submit/i })
    expect(submitBtn).toHaveProperty('disabled', true)

    // Click lodash option
    const lodashBtn = screen.getByRole('button', { name: /lodash/i })
    fireEvent.click(lodashBtn)

    // Submit should now be enabled
    expect(submitBtn).toHaveProperty('disabled', false)

    // lodash button should have aria-pressed="true"
    expect(lodashBtn.getAttribute('aria-pressed')).toBe('true')
  })

  it('single-select: clicking another option deselects the first', () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<GateResolver gate={sampleGate} onResolve={onResolve} />)

    const lodashBtn = screen.getByRole('button', { name: /lodash/i })
    const ramdaBtn = screen.getByRole('button', { name: /ramda/i })

    fireEvent.click(lodashBtn)
    expect(lodashBtn.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(ramdaBtn)
    expect(ramdaBtn.getAttribute('aria-pressed')).toBe('true')
    expect(lodashBtn.getAttribute('aria-pressed')).toBe('false')
  })

  it('submits selected option label as answer', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<GateResolver gate={sampleGate} onResolve={onResolve} />)

    fireEvent.click(screen.getByRole('button', { name: /lodash/i }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(onResolve).toHaveBeenCalledWith('gate-1', { answer: 'lodash' })
  })

  it('Other text input works as fallback', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<GateResolver gate={sampleGate} onResolve={onResolve} />)

    const otherInput = screen.getByPlaceholderText(/other/i)
    fireEvent.change(otherInput, { target: { value: 'underscore' } })

    // Submit should be enabled
    const submitBtn = screen.getByRole('button', { name: /submit/i })
    expect(submitBtn).toHaveProperty('disabled', false)

    fireEvent.click(submitBtn)
    expect(onResolve).toHaveBeenCalledWith('gate-1', { answer: 'underscore' })
  })

  it('multi-select: can toggle multiple options', () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<GateResolver gate={multiSelectGate} onResolve={onResolve} />)

    const darkBtn = screen.getByRole('button', { name: /dark-mode/i })
    const i18nBtn = screen.getByRole('button', { name: /i18n/i })

    fireEvent.click(darkBtn)
    fireEvent.click(i18nBtn)

    expect(darkBtn.getAttribute('aria-pressed')).toBe('true')
    expect(i18nBtn.getAttribute('aria-pressed')).toBe('true')
  })

  it('multi-select: submits comma-separated labels', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<GateResolver gate={multiSelectGate} onResolve={onResolve} />)

    fireEvent.click(screen.getByRole('button', { name: /dark-mode/i }))
    fireEvent.click(screen.getByRole('button', { name: /i18n/i }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(onResolve).toHaveBeenCalledWith('gate-2', { answer: 'dark-mode, i18n' })
  })

  it('renders multiple questions when array has 2+ items', () => {
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<GateResolver gate={multiQuestionGate} onResolve={onResolve} />)

    expect(screen.getByText('Which library?')).toBeTruthy()
    expect(screen.getByText('Which framework?')).toBeTruthy()
    expect(screen.getByText('Library')).toBeTruthy()
    expect(screen.getByText('Framework')).toBeTruthy()
  })
})

// Ensure existing permission_request gate still works
describe('GateResolver — permission_request (unchanged)', () => {
  it('renders approve/deny buttons for permission requests', () => {
    const gate = {
      id: 'perm-1',
      type: 'permission_request' as const,
      detail: { tool_name: 'Bash', command: 'rm -rf /' },
    }
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<GateResolver gate={gate} onResolve={onResolve} />)

    expect(screen.getByText(/approve/i)).toBeTruthy()
    expect(screen.getByText(/deny/i)).toBeTruthy()
  })
})

describe('GateResolver — legacy ask_user fallback', () => {
  it('renders simple text input when detail has no questions array', () => {
    const gate = {
      id: 'legacy-1',
      type: 'ask_user' as const,
      detail: { question: 'What is the project name?' },
    }
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<GateResolver gate={gate} onResolve={onResolve} />)

    expect(screen.getByText('What is the project name?')).toBeTruthy()
    expect(screen.getByPlaceholderText(/type your answer/i)).toBeTruthy()
  })

  it('submits legacy text answer on Enter', () => {
    const gate = {
      id: 'legacy-2',
      type: 'ask_user' as const,
      detail: { question: 'Pick a name' },
    }
    const onResolve = vi.fn().mockResolvedValue(undefined)
    render(<GateResolver gate={gate} onResolve={onResolve} />)

    const input = screen.getByPlaceholderText(/type your answer/i)
    fireEvent.change(input, { target: { value: 'my-project' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onResolve).toHaveBeenCalledWith('legacy-2', { answer: 'my-project' })
  })
})
