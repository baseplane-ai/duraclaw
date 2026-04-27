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
})
