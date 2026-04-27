/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectedPeersChip } from './ConnectedPeersChip'

afterEach(() => cleanup())

describe('ConnectedPeersChip', () => {
  it('renders nothing when there are no peers', () => {
    const { container } = render(<ConnectedPeersChip peers={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a human peer with name + color dot', () => {
    render(
      <ConnectedPeersChip
        peers={[{ clientId: 1, kind: 'human', name: 'Ada', color: '#ff0000' }]}
      />,
    )
    const chip = screen.getByTestId('peer-human-1')
    expect(chip.textContent).toContain('Ada')
  })

  it('renders a docs-runner peer with hostname styling', () => {
    render(
      <ConnectedPeersChip peers={[{ clientId: 42, kind: 'docs-runner', host: 'vps-east-1' }]} />,
    )
    const chip = screen.getByTestId('peer-runner-42')
    expect(chip.textContent).toContain('vps-east-1')
  })

  it('renders mixed peers in the same row', () => {
    render(
      <ConnectedPeersChip
        peers={[
          { clientId: 1, kind: 'human', name: 'Ada' },
          { clientId: 2, kind: 'docs-runner', host: 'vps-east-1' },
        ]}
      />,
    )
    expect(screen.getByTestId('peer-human-1')).toBeTruthy()
    expect(screen.getByTestId('peer-runner-2')).toBeTruthy()
  })

  // Defense-in-depth: awareness color values arrive over the wire from
  // arbitrary peers. We only honor 6-digit hex; anything else falls back
  // to the neutral default so a malicious peer can't inject CSS via the
  // inline `style={{ backgroundColor }}` write.
  it('rejects a non-hex color string and falls back to the default', () => {
    render(
      <ConnectedPeersChip
        peers={[
          {
            clientId: 7,
            kind: 'human',
            name: 'Mallory',
            color: 'red; background: url(javascript:alert(1))',
          },
        ]}
      />,
    )
    const chip = screen.getByTestId('peer-human-7')
    const dot = chip.querySelector('span[aria-hidden]') as HTMLSpanElement | null
    expect(dot).toBeTruthy()
    // jsdom normalises hex to rgb(); the malicious literal should never
    // make it onto the element.
    expect(dot?.style.backgroundColor).toBe('rgb(156, 163, 175)')
  })

  it('honors a well-formed hex color', () => {
    render(
      <ConnectedPeersChip
        peers={[{ clientId: 8, kind: 'human', name: 'Ada', color: '#ff0000' }]}
      />,
    )
    const chip = screen.getByTestId('peer-human-8')
    const dot = chip.querySelector('span[aria-hidden]') as HTMLSpanElement | null
    expect(dot?.style.backgroundColor).toBe('rgb(255, 0, 0)')
  })

  it('falls back when color is a 3-digit hex (only 6-digit accepted)', () => {
    render(
      <ConnectedPeersChip peers={[{ clientId: 9, kind: 'human', name: 'Ada', color: '#f00' }]} />,
    )
    const chip = screen.getByTestId('peer-human-9')
    const dot = chip.querySelector('span[aria-hidden]') as HTMLSpanElement | null
    expect(dot?.style.backgroundColor).toBe('rgb(156, 163, 175)')
  })
})
