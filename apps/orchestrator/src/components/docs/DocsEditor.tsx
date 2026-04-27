/**
 * DocsEditor (GH#27 P1.6 WU-C)
 *
 * Right-pane BlockNote editor for a single markdown file in the project's
 * docs worktree.
 *
 * Wiring:
 *   - `entityId = sha256(projectId + ':' + relPath)[0..16]` — derived
 *     once per (projectId, relPath) pair via `deriveEntityId`.
 *   - YPartyKitProvider connects to `wss://<host>/parties/repo-document/<entityId>`
 *     using the shared cookie-bearing fetch (Better Auth session cookie).
 *   - The Y.Doc's `DOCS_YDOC_FRAGMENT_NAME` XML fragment is the
 *     authoritative collab root, the same key the docs-runner and DO
 *     bind to (see `packages/docs-runner/src/blocknote-bridge.ts`).
 *   - BlockNote schema is restricted to default GFM-style blocks
 *     (paragraph, heading, lists, codeBlock, quote, table) — image /
 *     video / file / audio are excluded so the palette matches what the
 *     markdown bridge can serialise round-trip.
 */

import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'

import { BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core'
import { BlockNoteView } from '@blocknote/mantine'
import { useCreateBlockNote } from '@blocknote/react'
import { DOCS_YDOC_FRAGMENT_NAME, deriveEntityId } from '@duraclaw/shared-types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useYProvider from 'y-partyserver/react'
import * as Y from 'yjs'
import { useSession } from '~/lib/auth-client'
import { partyHost } from '~/lib/platform'
import { colorForUserId } from '~/lib/presence-colors'
import type { ConnectedPeer } from './ConnectedPeersChip'

/**
 * Out-of-band signals piggybacked on awareness from the DO/runner side.
 *   - `setup-required` → projectMetadata.docsWorktreePath is null;
 *     surface DocsWorktreeSetup modal (B12 → B19).
 *   - `tombstone-pending` → runner observed a delete on `relPath`;
 *     UI flips to strikethrough (B10 → B20).
 *   - `tombstone-cancelled` → file reappeared before the alarm fired;
 *     clear the strikethrough.
 */
export type DocsAwarenessSignal =
  | { kind: 'setup-required'; projectId?: string }
  | { kind: 'tombstone-pending'; relPath?: string; tombstoneAt?: number }
  | { kind: 'tombstone-cancelled'; relPath?: string }

export interface DocsEditorProps {
  projectId: string
  relPath: string
  /**
   * Called on every awareness update with the current peer set (excluding
   * the local clientId). The route lifts this so the chip lives in the
   * page header even though this component owns the provider.
   */
  onPeersChange?: (peers: ConnectedPeer[]) => void
  /**
   * Called when any peer publishes a `setup-required`, `tombstone-pending`,
   * or `tombstone-cancelled` awareness record. The route bubbles the
   * signal into modal / strikethrough state.
   */
  onAwarenessSignal?: (signal: DocsAwarenessSignal) => void
}

/**
 * GFM-restricted schema. Excludes the default `image`, `video`, `file`,
 * `audio`, `divider`, `checkListItem`, `toggleListItem` blocks because
 * the markdown round-trip used by the docs-runner can't preserve them
 * losslessly. Keeps: paragraph, headings, bulleted/ordered lists, code
 * block, quote, table.
 */
const docsSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    heading: defaultBlockSpecs.heading,
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    codeBlock: defaultBlockSpecs.codeBlock,
    quote: defaultBlockSpecs.quote,
    table: defaultBlockSpecs.table,
  },
})

export function DocsEditor(props: DocsEditorProps) {
  const [entityId, setEntityId] = useState<string | null>(null)

  // entityId derivation is async (crypto.subtle.digest) and depends on
  // the (projectId, relPath) pair. When either changes, recompute and
  // gate the editor render on the new value.
  useEffect(() => {
    let cancelled = false
    setEntityId(null)
    deriveEntityId(props.projectId, props.relPath).then((id) => {
      if (!cancelled) setEntityId(id)
    })
    return () => {
      cancelled = true
    }
  }, [props.projectId, props.relPath])

  if (!entityId) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading…
      </div>
    )
  }

  // Key on entityId so a file switch fully unmounts/remounts the
  // collab+editor stack — no Y.Doc / provider state leakage between docs.
  return (
    <DocsEditorInner
      key={entityId}
      entityId={entityId}
      relPath={props.relPath}
      onPeersChange={props.onPeersChange}
      onAwarenessSignal={props.onAwarenessSignal}
    />
  )
}

function DocsEditorInner({
  entityId,
  relPath,
  onPeersChange,
  onAwarenessSignal,
}: {
  entityId: string
  relPath: string
  onPeersChange?: (peers: ConnectedPeer[]) => void
  onAwarenessSignal?: (signal: DocsAwarenessSignal) => void
}) {
  // Fresh Y.Doc per (entityId) — guaranteed by the parent's `key=entityId`,
  // useMemo guards against StrictMode double-mount churn.
  const ydoc = useMemo(() => {
    const d = new Y.Doc()
    d.guid = `docs:${entityId}`
    return d
  }, [entityId])

  const provider = useYProvider({
    host: partyHost(),
    party: 'repo-document',
    room: entityId,
    doc: ydoc,
  })

  // BlockNote collaboration user — name from the Better Auth session
  // (falls back to "You"); color is deterministic on user id so peers see
  // the same color for a given user across reloads.
  const { data: session } = useSession() as {
    data: { user?: { id?: string; name?: string } } | null | undefined
  }
  const userId = session?.user?.id ?? null
  const userName = session?.user?.name ?? 'You'
  const userColor = userId ? colorForUserId(userId) : '#3b82f6'

  // The XML fragment name MUST match what the runner/DO bind to so the
  // three peers see the same collab tree.
  const fragment = useMemo(() => ydoc.getXmlFragment(DOCS_YDOC_FRAGMENT_NAME), [ydoc])

  const editor = useCreateBlockNote({
    schema: docsSchema,
    collaboration: {
      provider,
      fragment,
      user: { name: userName, color: userColor },
    },
  })

  // Publish our own awareness identity so peers (other browsers + the
  // docs-runner) can render us in their ConnectedPeersChip. We mark
  // ourselves `kind: 'human'`; the docs-runner sets `kind: 'docs-runner'`
  // (see packages/docs-runner/src/yjs-protocol.ts). The chip filters on
  // this discriminator at render time.
  //
  // Note on cursor overlay: BlockNote shows a cursor for any awareness
  // peer that publishes a selection. The docs-runner deliberately never
  // sets a selection, so no runner cursor overlay renders without an
  // explicit filter on our side. (See P1.7 WU-A spec.)
  useEffect(() => {
    const awareness = provider.awareness
    awareness.setLocalStateField('user', {
      name: userName,
      color: userColor,
      kind: 'human',
    })
    return () => {
      // Clear our identity on unmount/file-switch so peers don't see a
      // ghost. y-protocols also drops the state on WS close, but doing
      // it eagerly avoids a stale entry mid-tab-switch.
      awareness.setLocalStateField('user', null)
    }
  }, [provider, userName, userColor])

  // Stash the latest signal callback in a ref so the awareness handler
  // doesn't churn on every parent re-render — only the provider identity
  // should drive subscribe/unsubscribe.
  const signalRef = useRef(onAwarenessSignal)
  signalRef.current = onAwarenessSignal
  const peersRef = useRef(onPeersChange)
  peersRef.current = onPeersChange

  const handleAwarenessUpdate = useCallback(() => {
    const awareness = provider.awareness
    const localId = ydoc.clientID
    const states = awareness.getStates() as Map<number, Record<string, unknown>>
    const peers: ConnectedPeer[] = []
    for (const [clientId, state] of states) {
      if (clientId === localId) continue
      const user = (state.user ?? {}) as {
        name?: string
        color?: string
        kind?: string
        host?: string
        version?: string
      }
      peers.push({
        clientId,
        kind: user.kind,
        name: user.name,
        color: user.color,
        host: user.host,
        version: user.version,
      })

      // Out-of-band signals (B10/B12). Per the GH#27 spec these ride on
      // awareness records; the discriminator is `state.kind` (top-level)
      // OR `state.signal.kind`, so we check both shapes for forward-compat.
      const signalKind =
        (state.kind as string | undefined) ??
        (state.signal as { kind?: string } | undefined)?.kind ??
        undefined
      if (
        signalKind === 'setup-required' ||
        signalKind === 'tombstone-pending' ||
        signalKind === 'tombstone-cancelled'
      ) {
        const cb = signalRef.current
        if (cb) {
          // Pass through projectId / relPath / tombstoneAt if present.
          cb({
            kind: signalKind,
            ...(state as Record<string, unknown>),
          } as DocsAwarenessSignal)
        }
      }
    }
    const cb = peersRef.current
    if (cb) cb(peers)
  }, [provider, ydoc])

  useEffect(() => {
    const awareness = provider.awareness
    awareness.on('update', handleAwarenessUpdate)
    // Fire once on subscribe so the parent gets the initial snapshot
    // (peers already present at mount time).
    handleAwarenessUpdate()
    return () => {
      awareness.off('update', handleAwarenessUpdate)
    }
  }, [provider, handleAwarenessUpdate])

  // Provider + Y.Doc lifetime is tied to (entityId). Tear down on
  // unmount so a file switch doesn't leak the WS / awareness.
  useEffect(() => {
    return () => {
      try {
        provider.destroy()
      } catch {
        /* provider may already be torn down */
      }
      try {
        ydoc.destroy()
      } catch {
        /* defensive */
      }
    }
  }, [provider, ydoc])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-2 font-medium text-sm">{relPath}</div>
      <div className="flex-1 overflow-auto">
        <BlockNoteView editor={editor} />
      </div>
    </div>
  )
}
