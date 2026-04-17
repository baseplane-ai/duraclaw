/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CursorOverlay } from './cursor-overlay'

afterEach(() => cleanup())

interface FakeAwareness {
  getStates: () => Map<number, unknown>
  on: (evt: string, cb: () => void) => void
  off: (evt: string, cb: () => void) => void
}

/**
 * Build an awareness fake with a single remote peer whose cursor is at
 * index 2 of the Y.Text. jsdom doesn't layout text, so the mirror-div
 * span offsets are all zero — we assert on DOM presence / name / user id.
 */
function buildAwareness(ytext: Y.Text, peerName: string): FakeAwareness {
  const anchorRel = Y.createRelativePositionFromTypeIndex(ytext, 2)
  const headRel = Y.createRelativePositionFromTypeIndex(ytext, 2)
  const states = new Map<number, unknown>([
    [
      42,
      {
        user: { id: 'peer-1', name: peerName, color: '#3b82f6' },
        cursor: {
          anchor: Y.relativePositionToJSON(anchorRel),
          head: Y.relativePositionToJSON(headRel),
        },
      },
    ],
  ])
  return {
    getStates: () => states,
    on: () => {},
    off: () => {},
  }
}

describe('CursorOverlay', () => {
  it('renders a marker for a remote peer cursor with the peer name', () => {
    // Stub getComputedStyle so the mirror-div style copy doesn't bail
    // on missing jsdom properties.
    const originalGCS = window.getComputedStyle
    window.getComputedStyle = ((el: Element) => {
      const cs = originalGCS(el)
      return new Proxy(cs, {
        get(target, prop) {
          const v = (target as unknown as Record<string, unknown>)[prop as string]
          if (typeof v === 'string' || typeof v === 'number') return v
          if (prop === 'lineHeight') return '16px'
          return v ?? ''
        },
      }) as CSSStyleDeclaration
    }) as typeof window.getComputedStyle

    // Stub offsetTop / offsetLeft on HTMLSpanElement so the measurement
    // code has non-zero values and the marker lands inside the visible
    // viewport.
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get() {
        return 4
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
      configurable: true,
      get() {
        return 12
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return 16
      },
    })
    Object.defineProperty(HTMLTextAreaElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return 200
      },
    })
    Object.defineProperty(HTMLTextAreaElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return 48
      },
    })

    const doc = new Y.Doc()
    const ytext = doc.getText('draft')
    ytext.insert(0, '0123456789')

    const awareness = buildAwareness(ytext, 'Alice')
    const ref = createRef<HTMLTextAreaElement>()

    // Render a textarea so ref has a real element.
    function Harness() {
      return (
        <div>
          <textarea ref={ref} defaultValue="0123456789" />
          <CursorOverlay
            awareness={awareness as never}
            selfClientId={1}
            textareaRef={ref}
            doc={doc}
            ytext={ytext}
          />
        </div>
      )
    }

    render(<Harness />)

    const markers = screen.queryAllByTestId('cursor-overlay-marker')
    expect(markers.length).toBe(1)
    expect(markers[0].getAttribute('data-user-id')).toBe('peer-1')
    expect(screen.getByText('Alice')).toBeTruthy()

    window.getComputedStyle = originalGCS
    vi.restoreAllMocks()
  })
})
