/**
 * @vitest-environment jsdom
 *
 * GH#125 P1b regression test — guards the Tailwind-via-className fix
 * that restores button visuals after the Tamagui compiler dropped
 * token-referenced color/bg props inside `variants` blocks of the
 * `styled()` shell. The Tailwind classes assert here resolve through
 * CSS variables (var(--primary), etc.) defined in theme.css :root /
 * .dark and serve as the visual layer on top of the shell.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '~/test-utils'
import { Button } from './button'

afterEach(cleanup)

describe('Button (GH#125 P1b — Tailwind visual layer)', () => {
  it('default variant + size emits bg-primary, text-primary-foreground, h-9', () => {
    render(<Button>Sign in</Button>)
    const btn = screen.getByRole('button', { name: 'Sign in' })
    const cls = btn.className
    expect(cls).toContain('bg-primary')
    expect(cls).toContain('text-primary-foreground')
    expect(cls).toContain('h-9')
  })

  it('destructive + lg emits bg-destructive and h-10', () => {
    render(
      <Button variant="destructive" size="lg">
        Delete
      </Button>,
    )
    const btn = screen.getByRole('button', { name: 'Delete' })
    const cls = btn.className
    expect(cls).toContain('bg-destructive')
    expect(cls).toContain('h-10')
  })

  it('outline variant emits border + bg-background', () => {
    render(<Button variant="outline">Cancel</Button>)
    const btn = screen.getByRole('button', { name: 'Cancel' })
    const cls = btn.className
    expect(cls).toContain('border')
    expect(cls).toContain('bg-background')
  })
})
