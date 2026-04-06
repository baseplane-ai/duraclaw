// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSidebar } from './project-sidebar'

describe('ProjectSidebar', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/projects')) {
          return {
            ok: true,
            json: async () => ({ projects: [] }),
          }
        }

        return {
          ok: true,
          json: async () => ({ sessions: [] }),
        }
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens and closes the mobile drawer', async () => {
    const { queryByTestId, rerender } = render(
      <ProjectSidebar
        collapsed={false}
        mobileOpen
        onMobileOpenChange={() => {}}
        onToggleCollapse={() => {}}
      />,
    )

    await waitFor(() => {
      expect(queryByTestId('mobile-session-drawer')).toBeTruthy()
    })

    rerender(
      <ProjectSidebar
        collapsed={false}
        mobileOpen={false}
        onMobileOpenChange={() => {}}
        onToggleCollapse={() => {}}
      />,
    )

    expect(queryByTestId('mobile-session-drawer')).toBeNull()
  })
})
