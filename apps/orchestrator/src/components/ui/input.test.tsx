/**
 * @vitest-environment jsdom
 *
 * GH#125 P1b regression test — guards the Tailwind-via-className fix
 * that restores Input visuals (border, height, padding, focus-visible)
 * after the Tamagui compiler dropped token-referenced border/bg props
 * from the `styled()` shell.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '~/test-utils'
import { Input } from './input'

afterEach(cleanup)

describe('Input (GH#125 P1b — Tailwind visual layer)', () => {
  it('emits border + border-input + h-9 + rounded-md', () => {
    const { container } = render(<Input placeholder="Email" />)
    const el = container.querySelector('input') as HTMLInputElement
    expect(el).toBeTruthy()
    const cls = el.className
    expect(cls).toContain('border')
    expect(cls).toContain('border-input')
    expect(cls).toContain('h-9')
    expect(cls).toContain('rounded-md')
  })
})
