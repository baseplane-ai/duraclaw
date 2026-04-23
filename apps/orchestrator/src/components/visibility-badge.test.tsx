/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { VisibilityBadge } from './visibility-badge'

afterEach(() => cleanup())

describe('VisibilityBadge', () => {
  it('renders nothing when visibility is undefined', () => {
    const { container } = render(<VisibilityBadge visibility={undefined} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders the public badge with Globe icon', () => {
    render(<VisibilityBadge visibility="public" />)
    const badge = screen.getByLabelText('Public')
    expect(badge).toBeTruthy()
    // Globe icon is rendered as an SVG inside the span
    expect(badge.querySelector('svg')).toBeTruthy()
  })

  it('renders the private badge with Lock icon', () => {
    render(<VisibilityBadge visibility="private" />)
    const badge = screen.getByLabelText('Private')
    expect(badge).toBeTruthy()
    expect(badge.querySelector('svg')).toBeTruthy()
  })

  it('renders the label text when showLabel is true', () => {
    render(<VisibilityBadge visibility="public" showLabel />)
    expect(screen.getByText('Public')).toBeTruthy()
  })

  it('omits the label text by default', () => {
    render(<VisibilityBadge visibility="private" />)
    expect(screen.queryByText('Private')).toBeNull()
  })
})
