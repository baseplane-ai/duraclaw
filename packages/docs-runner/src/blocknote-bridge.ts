import './jsdom-bootstrap.js'

import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { DOCS_YDOC_FRAGMENT_NAME, DOCS_YDOC_META_MAP_NAME } from '@duraclaw/shared-types'
import matter from 'gray-matter'
import * as Y from 'yjs'

/**
 * Markdown ↔ Y.Doc bridge for the docs-runner (B7 + P1.9).
 *
 * This module owns the deterministic transform between an on-disk markdown
 * document — including its YAML frontmatter — and the `Y.XmlFragment` that
 * the `RepoDocumentDO` mirrors over y-partyserver. Frontmatter is parsed
 * via gray-matter, stored on the doc's `Y.Map(DOCS_YDOC_META_MAP_NAME)`,
 * and re-prepended to the serialised body on the way back to disk.
 *
 * All four exported functions are deterministic and synchronous wrt their
 * Y.Doc argument: they apply mutations directly via Yjs (the body fragment
 * + the meta map are both touched inside a single `Y.transact` so peers
 * observe one update), so callers can wrap invocations in their own
 * `Y.transact()` if they want a single update batch with additional
 * mutations.
 *
 * Shared keys: `DOCS_YDOC_FRAGMENT_NAME` (body) and
 * `DOCS_YDOC_META_MAP_NAME` (frontmatter), both from `@duraclaw/shared-types`.
 * Runner, DO, and browser editor MUST all use these constants (see spike
 * result N3) — never hardcode the strings.
 */

/**
 * Build a fresh `ServerBlockNoteEditor`. Cheap to call — instances are
 * stateless wrt Y.Doc. Callers MAY pass an existing editor into the
 * round-trip helpers to avoid re-allocation in hot loops.
 */
export function createBlockNoteEditor(): ServerBlockNoteEditor {
  return ServerBlockNoteEditor.create()
}

/**
 * Apply a markdown document (body + optional YAML frontmatter) as a Yjs
 * update on `ydoc`. The body lands on `DOCS_YDOC_FRAGMENT_NAME`; the
 * parsed frontmatter populates `DOCS_YDOC_META_MAP_NAME` (existing keys
 * not present in the new data are removed so the map mirrors the input
 * frontmatter exactly).
 *
 * Mutates the doc in place. Both the body fragment and the meta map are
 * mutated inside a single `Y.transact` so peers receive one update.
 */
export async function markdownToYDoc(md: string, ydoc: Y.Doc): Promise<void> {
  const parsed = matter(md)
  const editor = createBlockNoteEditor()
  const blocks = await editor.tryParseMarkdownToBlocks(parsed.content)
  const fragment = ydoc.getXmlFragment(DOCS_YDOC_FRAGMENT_NAME)
  const metaMap = ydoc.getMap<unknown>(DOCS_YDOC_META_MAP_NAME)

  Y.transact(ydoc, () => {
    editor.blocksToYXmlFragment(blocks, fragment)
    const nextKeys = new Set(Object.keys(parsed.data))
    for (const key of [...metaMap.keys()]) {
      if (!nextKeys.has(key)) metaMap.delete(key)
    }
    for (const [key, value] of Object.entries(parsed.data)) {
      metaMap.set(key, value)
    }
  })
}

/**
 * Serialise `ydoc` back to a markdown document via BlockNote's lossy
 * serialiser, restoring any YAML frontmatter held on
 * `DOCS_YDOC_META_MAP_NAME` as a `---\n...\n---\n` prefix via
 * `gray-matter.stringify`. Cosmetic differences vs the original input
 * are expected on the body (bullet style, list looseness, table cell
 * padding) — callers that need byte-exact comparison should use
 * `normalisedMarkdown()` to canonicalise both sides.
 *
 * `editor` is optional — pass one in to avoid the per-call allocation.
 */
export async function yDocToMarkdown(
  ydoc: Y.Doc,
  editor: ServerBlockNoteEditor = createBlockNoteEditor(),
): Promise<string> {
  const fragment = ydoc.getXmlFragment(DOCS_YDOC_FRAGMENT_NAME)
  const blocks = editor.yXmlFragmentToBlocks(fragment)
  const body = await editor.blocksToMarkdownLossy(blocks)
  const metaMap = ydoc.getMap<unknown>(DOCS_YDOC_META_MAP_NAME)
  const data = metaMap.toJSON()
  if (Object.keys(data).length === 0) return body
  return matter.stringify(body, data)
}

/**
 * Round-trip `md` through BlockNote's parse + serialise to obtain the
 * canonical, BlockNote-stable form, preserving frontmatter unchanged.
 * Used by the content-hash gate (B8 + spike result N1) so disk-side and
 * DO-side hashes are computed over the same normalised bytes —
 * preventing write-back churn from cosmetic differences (bullet markers,
 * list looseness, table cell padding). Frontmatter participates in the
 * canonical bytes so a metadata-only edit hashes differently from no
 * change.
 */
export async function normalisedMarkdown(md: string): Promise<string> {
  const parsed = matter(md)
  const editor = createBlockNoteEditor()
  const blocks = await editor.tryParseMarkdownToBlocks(parsed.content)
  const body = await editor.blocksToMarkdownLossy(blocks)
  if (Object.keys(parsed.data).length === 0) return body
  return matter.stringify(body, parsed.data)
}
