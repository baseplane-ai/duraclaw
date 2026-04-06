// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionState } from '~/lib/types'
import { normalizeQuestions, QuestionPrompt, SessionHeader } from './chat-view'

describe('QuestionPrompt', () => {
  it('normalizes confirmation questions from gateway shape', () => {
    expect(
      normalizeQuestions([
        {
          header: 'Confirmation',
          options: [
            { label: 'Yes, proceed', description: 'Start verification work' },
            { label: 'No, cancel', description: 'Cancel and wait for instructions' },
          ],
          question: 'Proceed with verification?',
        },
      ]),
    ).toMatchObject([
      {
        header: 'Confirmation',
        id: 'question-0',
        required: true,
        text: 'Proceed with verification?',
        type: 'confirm',
      },
    ])
  })

  it('renders confirmation buttons and validates required answers', () => {
    const onSubmit = vi.fn()

    render(
      <QuestionPrompt
        onSubmit={onSubmit}
        questions={[
          {
            header: 'Confirmation',
            options: [{ label: 'Yes, proceed' }, { label: 'No, cancel' }],
            question: 'Proceed with verification?',
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByTestId('question-submit'))
    expect(screen.getByText('This answer is required before continuing.')).toBeTruthy()

    fireEvent.click(screen.getByText('Yes, proceed'))
    fireEvent.click(screen.getByTestId('question-submit'))

    expect(onSubmit).toHaveBeenCalledWith({ 'question-0': 'Yes, proceed' })
  })
})

describe('SessionHeader', () => {
  it('renders model, turns, duration, and cost', () => {
    const session: SessionState = {
      created_at: '2026-04-03T00:00:00.000Z',
      duration_ms: 65000,
      error: null,
      id: 'session-1',
      model: 'claude-sonnet-4-6',
      num_turns: 3,
      pending_permission: null,
      pending_question: null,
      project: 'baseplane',
      project_path: '/data/projects/baseplane',
      prompt: 'test',
      result: null,
      sdk_session_id: null,
      status: 'running',
      summary: null,
      total_cost_usd: 0.0123,
      updated_at: '2026-04-03T00:00:00.000Z',
      userId: 'user-1',
    }

    render(<SessionHeader onAbort={() => {}} session={session} />)

    expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy()
    expect(screen.getByText('3 turns')).toBeTruthy()
    expect(screen.getByText('1m 5s')).toBeTruthy()
    expect(screen.getByText('$0.0123')).toBeTruthy()
  })
})
