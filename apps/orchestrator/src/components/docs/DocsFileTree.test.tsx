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
})
