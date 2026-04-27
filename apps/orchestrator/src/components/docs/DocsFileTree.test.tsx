/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocsFileTree } from './DocsFileTree'

afterEach(() => cleanup())

describe('DocsFileTree', () => {
  it('renders empty-state when there are no files', () => {
    render(<DocsFileTree files={[]} selected={null} onSelect={() => {}} />)
    expect(screen.getByText(/no markdown files/i)).toBeTruthy()
  })

  it('groups files by directory and renders leaves', () => {
    const files = [
      { relPath: 'README.md', lastModified: 1 },
      { relPath: 'planning/foo.md', lastModified: 2 },
      { relPath: 'planning/bar.md', lastModified: 3 },
      { relPath: 'planning/specs/a.md', lastModified: 4 },
    ]
    render(<DocsFileTree files={files} selected={null} onSelect={() => {}} />)

    // Directories show as their last segment.
    expect(screen.getByTestId('docs-tree-dir-planning')).toBeTruthy()
    expect(screen.getByTestId('docs-tree-dir-planning/specs')).toBeTruthy()

    // Files show keyed by full relPath.
    expect(screen.getByTestId('docs-tree-file-README.md')).toBeTruthy()
    expect(screen.getByTestId('docs-tree-file-planning/foo.md')).toBeTruthy()
    expect(screen.getByTestId('docs-tree-file-planning/bar.md')).toBeTruthy()
    expect(screen.getByTestId('docs-tree-file-planning/specs/a.md')).toBeTruthy()
  })

  it('fires onSelect with the relPath when a file is clicked', () => {
    const onSelect = vi.fn()
    const files = [{ relPath: 'planning/foo.md', lastModified: 1 }]
    render(<DocsFileTree files={files} selected={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('docs-tree-file-planning/foo.md'))
    expect(onSelect).toHaveBeenCalledWith('planning/foo.md')
  })

  it('renders a colored state dot for files with a known state', () => {
    const files = [
      { relPath: 'a.md', lastModified: 1 },
      { relPath: 'b.md', lastModified: 2 },
      { relPath: 'c.md', lastModified: 3 },
    ]
    const fileStates = new Map<string, 'syncing' | 'disconnected' | 'starting'>([
      ['a.md', 'syncing'],
      ['b.md', 'disconnected'],
    ])
    render(
      <DocsFileTree files={files} selected={null} onSelect={() => {}} fileStates={fileStates} />,
    )

    const a = screen.getByTestId('docs-tree-file-a.md')
    expect(a.getAttribute('data-state')).toBe('syncing')
    expect(a.querySelector('[data-testid="docs-tree-state-dot-syncing"]')).toBeTruthy()

    const b = screen.getByTestId('docs-tree-file-b.md')
    expect(b.getAttribute('data-state')).toBe('disconnected')
    expect(b.querySelector('[data-testid="docs-tree-state-dot-disconnected"]')).toBeTruthy()

    // c.md has no fileStates entry → no dot
    const c = screen.getByTestId('docs-tree-file-c.md')
    expect(c.getAttribute('data-state')).toBeNull()
    expect(c.querySelector('[data-testid^="docs-tree-state-dot-"]')).toBeNull()
  })
})
