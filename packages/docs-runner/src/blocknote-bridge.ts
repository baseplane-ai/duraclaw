import './jsdom-bootstrap.js'

import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { DOCS_YDOC_FRAGMENT_NAME } from '@duraclaw/shared-types'
import type * as Y from 'yjs'

/**
 * Markdown ↔ Y.Doc bridge for the docs-runner (B7).
 *
 * This module owns the deterministic transform between an on-disk markdown
 * body (frontmatter already stripped — gray-matter integration is P1.9) and
 * the `Y.XmlFragment` that the `RepoDocumentDO` mirrors over y-partyserver.
 *
 * All four exported functions are pure and synchronous wrt their Y.Doc
 * argument: they apply mutations directly via Yjs, so callers can wrap
 * invocations in `Y.transact()` if they want a single update batch.
 *
 * Shared fragment name: `DOCS_YDOC_FRAGMENT_NAME` from `@duraclaw/shared-types`.
 * Runner, DO, and browser editor MUST all use this constant (see spike result
 * N3) — never hardcode the string.
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
 * Apply a markdown body as a Yjs update on `ydoc`'s
 * `DOCS_YDOC_FRAGMENT_NAME` fragment.
 *
 * Mutates the doc in place. Does NOT replace its state — emits a single
 * Yjs update that other peers receive over the wire as an incremental delta.
 *
 * Frontmatter is NOT handled here; callers must strip it first
 * (gray-matter integration lands in P1.9).
 */
export async function markdownToYDoc(md: string, ydoc: Y.Doc): Promise<void> {
  const editor = createBlockNoteEditor()
  const blocks = await editor.tryParseMarkdownToBlocks(md)
  const fragment = ydoc.getXmlFragment(DOCS_YDOC_FRAGMENT_NAME)
  editor.blocksToYXmlFragment(blocks, fragment)
}

/**
 * Serialise the `DOCS_YDOC_FRAGMENT_NAME` fragment of `ydoc` back to
 * markdown via BlockNote's lossy serialiser. Cosmetic differences vs the
 * original input are expected (bullet style, list looseness, table cell
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
  return editor.blocksToMarkdownLossy(blocks)
}

/**
 * Round-trip `md` through BlockNote's parse + serialise to obtain the
 * canonical, BlockNote-stable form. Used by the content-hash gate (B8 +
 * spike result N1) so disk-side and DO-side hashes are computed over the
 * same normalised bytes — preventing write-back churn from cosmetic
 * differences (bullet markers, list looseness, table cell padding).
 */
export async function normalisedMarkdown(md: string): Promise<string> {
  const editor = createBlockNoteEditor()
  const blocks = await editor.tryParseMarkdownToBlocks(md)
  return editor.blocksToMarkdownLossy(blocks)
}
