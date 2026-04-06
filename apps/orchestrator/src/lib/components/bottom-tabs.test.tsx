// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BottomTabs } from './bottom-tabs'

describe('BottomTabs', () => {
  it('renders the active dashboard tab and routes actions', () => {
    const onNavigate = vi.fn()
    const onOpenSessions = vi.fn()

    render(<BottomTabs onNavigate={onNavigate} onOpenSessions={onOpenSessions} pathname="/" />)

    expect(screen.getByTestId('bottom-tab-dashboard').className).toContain('bg-accent')

    fireEvent.click(screen.getByTestId('bottom-tab-sessions'))
    fireEvent.click(screen.getByTestId('bottom-tab-settings'))

    expect(onOpenSessions).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith('/settings')
  })
})
