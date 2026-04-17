/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CursorOverlay } from './cursor-overlay'

afterEach(() => cleanup())

/**
 * Proto-prop overrides we install for measurement tests. Capturing the
 * original descriptor (which may be `undefined` for jsdom defaults) lets
 * us restore state cleanly so this file doesn't contaminate later tests
 * that rely on the real HTMLElement layout shims.
 */
type ProtoOverride = {
  proto: object
  prop: string
  value: number
}

function installProtoOverrides(overrides: ProtoOverride[]): () => void {
  const saved: Array<{
    proto: object
    prop: string
    descriptor: PropertyDescriptor | undefined
  }> = []
  for (const { proto, prop, value } of overrides) {
    saved.push({
      proto,
      prop,
      descriptor: Object.getOwnPropertyDescriptor(proto, prop),
    })
    Object.defineProperty(proto, prop, {
      configurable: true,
      get() {
        return value
      },
    })
  }
  return () => {
    for (const { proto, prop, descriptor } of saved) {
      if (descriptor) {
        Object.defineProperty(proto, prop, descriptor)
      } else {
        delete (proto as Record<string, unknown>)[prop]
      }
    }
  }
}

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
  let originalGCS: typeof window.getComputedStyle
  let restoreProtos: (() => void) | null = null

  beforeEach(() => {
    // Stub getComputedStyle so the mirror-div style copy doesn't bail
    // on missing jsdom properties.
    originalGCS = window.getComputedStyle
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
    // viewport. Capture originals so later tests in this file aren't
    // contaminated.
    restoreProtos = installProtoOverrides([
      { proto: HTMLElement.prototype, prop: 'offsetTop', value: 4 },
      { proto: HTMLElement.prototype, prop: 'offsetLeft', value: 12 },
      { proto: HTMLElement.prototype, prop: 'offsetHeight', value: 16 },
      { proto: HTMLTextAreaElement.prototype, prop: 'clientWidth', value: 200 },
      { proto: HTMLTextAreaElement.prototype, prop: 'clientHeight', value: 48 },
    ])
  })

  afterEach(() => {
    window.getComputedStyle = originalGCS
    if (restoreProtos) {
      restoreProtos()
      restoreProtos = null
    }
    vi.restoreAllMocks()
  })

  it('renders a marker for a remote peer cursor with the peer name', () => {
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
  })
})
