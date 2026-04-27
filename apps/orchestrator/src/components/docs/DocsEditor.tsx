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
import { useEffect, useMemo, useState } from 'react'
import useYProvider from 'y-partyserver/react'
import * as Y from 'yjs'
import { useSession } from '~/lib/auth-client'
import { partyHost } from '~/lib/platform'
import { colorForUserId } from '~/lib/presence-colors'

export interface DocsEditorProps {
  projectId: string
  relPath: string
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
  return <DocsEditorInner key={entityId} entityId={entityId} relPath={props.relPath} />
}

function DocsEditorInner({ entityId, relPath }: { entityId: string; relPath: string }) {
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
