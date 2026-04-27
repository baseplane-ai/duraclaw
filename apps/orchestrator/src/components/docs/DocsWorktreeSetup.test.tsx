/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocsWorktreeSetup } from './DocsWorktreeSetup'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('DocsWorktreeSetup', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
  })

  it('renders nothing when isOpen is false', () => {
    render(
      <DocsWorktreeSetup
        projectId="duraclaw"
        isOpen={false}
        reason="first-run"
        onClose={() => {}}
        onConfigured={() => {}}
      />,
    )
    expect(screen.queryByTestId('docs-worktree-setup')).toBeNull()
  })

  it('renders the snippet derived from projectName', () => {
    render(
      <DocsWorktreeSetup
        projectId="my-id"
        projectName="My Cool Project"
        isOpen
        reason="first-run"
        onClose={() => {}}
        onConfigured={() => {}}
      />,
    )
    const snippet = screen.getByTestId('docs-worktree-snippet')
    expect(snippet.textContent).toBe('git worktree add ../my-cool-project-docs main')
  })

  it('PATCHes /api/projects/:projectId on submit and calls onConfigured + onClose on success', async () => {
    const onConfigured = vi.fn()
    const onClose = vi.fn()
    render(
      <DocsWorktreeSetup
        projectId="duraclaw"
        projectName="duraclaw"
        isOpen
        reason="first-run"
        onClose={onClose}
        onConfigured={onConfigured}
      />,
    )

    const input = screen.getByTestId('docs-worktree-path') as HTMLInputElement
    fireEvent.change(input, { target: { value: '/data/projects/duraclaw-docs' } })
    fireEvent.click(screen.getByTestId('docs-worktree-submit'))

    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/projects/duraclaw')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({
      docsWorktreePath: '/data/projects/duraclaw-docs',
    })
  })

  it('rejects relative paths with an inline error and does not fetch', () => {
    const onConfigured = vi.fn()
    render(
      <DocsWorktreeSetup
        projectId="duraclaw"
        isOpen
        reason="first-run"
        onClose={() => {}}
        onConfigured={onConfigured}
      />,
    )
    const input = screen.getByTestId('docs-worktree-path') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'relative/path' } })
    fireEvent.click(screen.getByTestId('docs-worktree-submit'))

    expect(screen.getByTestId('docs-worktree-error').textContent).toMatch(/absolute/i)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(onConfigured).not.toHaveBeenCalled()
  })

  it('surfaces server error on non-2xx response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    const onConfigured = vi.fn()
    render(
      <DocsWorktreeSetup
        projectId="duraclaw"
        isOpen
        reason="first-run"
        onClose={() => {}}
        onConfigured={onConfigured}
      />,
    )
    const input = screen.getByTestId('docs-worktree-path') as HTMLInputElement
    fireEvent.change(input, { target: { value: '/abs/path' } })
    fireEvent.click(screen.getByTestId('docs-worktree-submit'))

    await waitFor(() => expect(screen.getByTestId('docs-worktree-error')).toBeTruthy())
    expect(onConfigured).not.toHaveBeenCalled()
  })
})
