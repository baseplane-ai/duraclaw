/**
 * CursorOverlay — renders remote peer carets / selections on top of the
 * shared-draft `<textarea>`.
 *
 * Technique: mirror-div. A `<div>` absolutely positioned over the
 * textarea holds an invisible clone of the text with identical typography
 * (font, padding, line-height, width, white-space, word-wrap). A `<span>`
 * sentinel is inserted at each peer's cursor index; its `offsetTop` /
 * `offsetLeft` give pixel coordinates for the visible bar + name badge.
 * This matches the strategy used by textarea-caret-position / CodeMirror
 * and handles auto-grow and scrolling via a `ResizeObserver` and a
 * textarea `scroll` listener.
 *
 * The overlay never mutates the textarea — it's a read-only visual layer
 * with `pointer-events: none` so clicks still reach the textarea.
 */

import type * as React from 'react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { colorForUserId } from '~/lib/presence-colors'

interface RelPosJSON {
  anchor: unknown
  head: unknown
}

interface PeerState {
  user?: { id?: string; name?: string; color?: string }
  cursor?: RelPosJSON | null
}

interface CursorOverlayProps {
  awareness: Awareness
  selfClientId: number
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  doc: Y.Doc
  ytext: Y.Text
}

interface ResolvedPeer {
  clientId: number
  userId: string
  name: string
  color: string
  anchor: number
  head: number
}

/**
 * Style properties we copy from the textarea onto the mirror div so
 * character metrics line up exactly. `textarea`-specific attributes
 * (selection, resize handle) are intentionally skipped.
 */
const MIRROR_STYLE_PROPS: readonly (keyof CSSStyleDeclaration)[] = [
  'boxSizing',
  'fontFamily',
  'fontFeatureSettings',
  'fontKerning',
  'fontSize',
  'fontStretch',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'tabSize',
  'textIndent',
  'textTransform',
  'wordSpacing',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderRightWidth',
  'borderTopWidth',
] as const

function subscribe(awareness: Awareness, cb: () => void): () => void {
  awareness.on('change', cb)
  return () => awareness.off('change', cb)
}

/**
 * Stable-string snapshot for useSyncExternalStore. Captures just the
 * peer cursor payloads (id, name, color, relative position JSON) so
 * React bails out when the remote cursors haven't moved.
 */
function readSnapshot(awareness: Awareness, selfClientId: number): string {
  const states = awareness.getStates() as Map<number, PeerState>
  const rows: Array<{
    clientId: number
    userId: string
    name: string
    color: string
    cursor: RelPosJSON
  }> = []
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue
    const userId = state.user?.id
    if (!userId) continue
    const cursor = state.cursor
    if (!cursor?.anchor || !cursor.head) continue
    rows.push({
      clientId,
      userId,
      name: state.user?.name ?? 'Anonymous',
      color: state.user?.color ?? colorForUserId(userId),
      cursor,
    })
  }
  rows.sort((a, b) => a.clientId - b.clientId)
  return JSON.stringify(rows)
}

/**
 * Copy text + caret metrics from the real textarea to the mirror div.
 * Called on every render (positions depend on layout).
 */
function syncMirrorStyle(mirror: HTMLDivElement, textarea: HTMLTextAreaElement) {
  const cs = window.getComputedStyle(textarea)
  const mirrorStyle = mirror.style as unknown as Record<string, string>
  const computed = cs as unknown as Record<string, string>
  for (const prop of MIRROR_STYLE_PROPS) {
    mirrorStyle[prop as string] = computed[prop as string]
  }
  mirror.style.width = `${textarea.clientWidth}px`
  mirror.style.height = `${textarea.clientHeight}px`
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  mirror.style.overflow = 'hidden'
  mirror.style.visibility = 'hidden'
  mirror.style.position = 'absolute'
  mirror.style.top = '0'
  mirror.style.left = '0'
  mirror.style.pointerEvents = 'none'
}

export function CursorOverlay({
  awareness,
  selfClientId,
  textareaRef,
  doc,
  ytext,
}: CursorOverlayProps) {
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  // Bump counter to force re-measure on textarea resize / scroll.
  const [, setBump] = useState(0)
  const bump = useCallback(() => setBump((n) => (n + 1) % 1_000_000), [])

  const snapshot = useSyncExternalStore(
    (cb) => subscribe(awareness, cb),
    () => readSnapshot(awareness, selfClientId),
    () => '[]',
  )

  // Re-render on local Y.Text edits (so remote cursors stay attached to
  // their RelativePosition as our index shifts).
  useEffect(() => {
    const onUpdate = () => bump()
    ytext.observe(onUpdate)
    return () => ytext.unobserve(onUpdate)
  }, [ytext, bump])

  // Re-measure on textarea resize (chat input auto-grows).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => bump())
    ro.observe(el)
    return () => ro.disconnect()
  }, [textareaRef, bump])

  // Scroll sync: keep the mirror's scrollTop aligned so line indices
  // match, and re-render so off-screen markers hide.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const onScroll = () => {
      const mirror = mirrorRef.current
      if (mirror) mirror.scrollTop = el.scrollTop
      bump()
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [textareaRef, bump])

  // Each render: sync mirror styles + text, then measure.
  const [markers, setMarkers] = useState<
    Array<{
      peer: ResolvedPeer
      top: number
      left: number
      height: number
      selection?: { top: number; left: number; height: number; width: number } | null
    }>
  >([])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    const mirror = mirrorRef.current
    if (!textarea || !mirror) {
      setMarkers([])
      return
    }
    syncMirrorStyle(mirror, textarea)
    mirror.scrollTop = textarea.scrollTop

    const rows = JSON.parse(snapshot) as Array<{
      clientId: number
      userId: string
      name: string
      color: string
      cursor: RelPosJSON
    }>

    const resolved: ResolvedPeer[] = []
    for (const row of rows) {
      try {
        const anchorRel = Y.createRelativePositionFromJSON(row.cursor.anchor)
        const headRel = Y.createRelativePositionFromJSON(row.cursor.head)
        const anchorAbs = Y.createAbsolutePositionFromRelativePosition(anchorRel, doc)
        const headAbs = Y.createAbsolutePositionFromRelativePosition(headRel, doc)
        if (!anchorAbs || !headAbs) continue
        if (anchorAbs.type !== ytext || headAbs.type !== ytext) continue
        resolved.push({
          clientId: row.clientId,
          userId: row.userId,
          name: row.name,
          color: row.color,
          anchor: anchorAbs.index,
          head: headAbs.index,
        })
      } catch {
        // Malformed payload or stale relative position — skip silently.
      }
    }

    const text = ytext.toString()
    const next: Array<{
      peer: ResolvedPeer
      top: number
      left: number
      height: number
      selection?: { top: number; left: number; height: number; width: number } | null
    }> = []

    // For each peer, mount a span at its head index inside the mirror
    // and read the offset. We do this one peer at a time (cheap — at most
    // a handful of peers) so spans don't collide.
    const visibleTop = textarea.scrollTop
    const visibleBottom = textarea.scrollTop + textarea.clientHeight

    for (const peer of resolved) {
      // Build mirror content: [before][span][after]. Strip existing
      // children and rebuild each iteration so the span is the only
      // positioned sentinel.
      mirror.textContent = ''
      const before = document.createTextNode(text.slice(0, peer.head))
      const span = document.createElement('span')
      span.textContent = '\u200b' // zero-width — takes no visual space but has a box.
      const after = document.createTextNode(text.slice(peer.head))
      mirror.appendChild(before)
      mirror.appendChild(span)
      mirror.appendChild(after)

      const top = span.offsetTop
      const left = span.offsetLeft
      const height =
        span.offsetHeight || parseFloat(window.getComputedStyle(mirror).lineHeight) || 16

      // Hide markers scrolled out of view.
      const absTop = top - textarea.scrollTop
      if (top < visibleTop - height || top > visibleBottom) continue

      // Selection (anchor !== head) — measure anchor position too.
      let selection: { top: number; left: number; height: number; width: number } | null = null
      if (peer.anchor !== peer.head) {
        mirror.textContent = ''
        const b2 = document.createTextNode(text.slice(0, peer.anchor))
        const sp2 = document.createElement('span')
        sp2.textContent = '\u200b'
        const a2 = document.createTextNode(text.slice(peer.anchor))
        mirror.appendChild(b2)
        mirror.appendChild(sp2)
        mirror.appendChild(a2)
        const anchorTop = sp2.offsetTop
        const anchorLeft = sp2.offsetLeft
        // Only rendered correctly for same-line single-span selections.
        // Multi-line selections draw a simple rectangular hull — good
        // enough as a visual hint without doing full range measurement.
        const selTop = Math.min(anchorTop, top) - textarea.scrollTop
        const selHeight = Math.abs(anchorTop - top) + height
        const selLeft = Math.min(anchorLeft, left)
        const selWidth = Math.max(Math.abs(anchorLeft - left), 2)
        selection = { top: selTop, left: selLeft, height: selHeight, width: selWidth }
      }

      next.push({
        peer,
        top: absTop,
        left,
        height,
        selection,
      })
    }

    // Clean up the mirror after measuring so hit-testing / screen readers
    // don't see stale text.
    mirror.textContent = ''

    setMarkers(next)
  }, [snapshot, textareaRef, ytext, doc])

  return (
    <div
      data-testid="cursor-overlay"
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <div ref={mirrorRef} data-testid="cursor-overlay-mirror" />
      {markers.map(({ peer, top, left, height, selection }) => (
        <div key={peer.clientId} data-testid="cursor-overlay-marker" data-user-id={peer.userId}>
          {selection && (
            <div
              data-testid="cursor-overlay-selection"
              style={{
                position: 'absolute',
                top: selection.top,
                left: selection.left,
                width: selection.width,
                height: selection.height,
                backgroundColor: peer.color,
                opacity: 0.2,
                borderRadius: 2,
              }}
            />
          )}
          <div
            style={{
              position: 'absolute',
              top,
              left,
              width: 2,
              height,
              backgroundColor: peer.color,
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: Math.max(0, top - 16),
              left,
              backgroundColor: peer.color,
              color: 'white',
              fontSize: 10,
              lineHeight: '14px',
              padding: '0 4px',
              borderRadius: 3,
              whiteSpace: 'nowrap',
              fontFamily:
                "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
            }}
          >
            {peer.name}
          </div>
        </div>
      ))}
    </div>
  )
}
