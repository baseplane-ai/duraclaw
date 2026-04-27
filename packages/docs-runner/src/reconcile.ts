import './jsdom-bootstrap.js'

import fs from 'node:fs/promises'
import type { ServerBlockNoteEditor } from '@blocknote/server-util'
import type * as Y from 'yjs'
import { markdownToYDoc, yDocToMarkdown } from './blocknote-bridge.js'
import { type HashStore, hashOfNormalisedMarkdown } from './content-hash.js'
import { assertWithinRoot } from './path-safety.js'
import type { SuppressedWriter } from './writer.js'

/**
 * Runner-startup reconciliation (B7 lines 343–362).
 *
 * Resolves disk vs DO state for a single tracked file after the
 * DialBackDocClient has completed Yjs sync 1/2. The Y.Doc passed in MUST
 * already reflect the DO's last-persisted state — this module is purely
 * local: it never touches the WS.
 *
 * Cases:
 *   - A — diskHash == lastCommittedHash: DO is authoritative; serialise
 *     DO Y.Doc → disk via the suppressed-writer.
 *   - B — disk differs from lastCommittedHash AND DO Y.Doc is empty:
 *     disk is the seed; push disk → Y.Doc as a fresh update. The CALLER
 *     is responsible for forwarding the resulting Yjs updates to the DO
 *     via the DialBackDocClient — reconcile does NOT touch the WS.
 *   - C — disk differs AND DO has content: both diverged. Apply disk-side
 *     markdown as a Y.Doc update on top of the existing state (BlockNote's
 *     `markdownToYDoc` accumulates updates, so this CRDT-merges). Re-write
 *     the merged Y.Doc back to disk via the writer. As with Case B, the
 *     CALLER forwards the resulting Yjs updates to the DO.
 *
 * Edge cases that fall out of the algorithm:
 *   - 'no-disk-do-empty' — file does not exist on disk AND DO Y.Doc is
 *     empty. Nothing to do; clear any stale hash entry.
 *   - 'no-disk-do-content' — file does not exist on disk but DO has
 *     content (browser-ahead-of-disk). Write the DO's content to disk as
 *     a new file via the writer.
 */

export type ReconcileCase = 'A' | 'B' | 'C' | 'no-disk-do-empty' | 'no-disk-do-content'

export interface ReconcileResult {
  case: ReconcileCase
  diskHash: string | null
  doHash: string
  /** human-readable string for logs */
  action: string
}

export interface ReconcileOptions {
  /** = docsWorktreePath */
  rootPath: string
  /** file relative to rootPath */
  relPath: string
  /** already populated by sync 1/2 with the DO */
  ydoc: Y.Doc
  hashStore: HashStore
  writer: SuppressedWriter
  /** optional reuse to avoid per-call construction */
  editor?: ServerBlockNoteEditor
}

/**
 * Read `absPath` as utf-8 markdown, returning `null` on ENOENT and
 * rethrowing all other errors.
 */
async function readDiskMd(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw err
  }
}

export async function reconcileOnAttach(opts: ReconcileOptions): Promise<ReconcileResult> {
  const { rootPath, relPath, ydoc, hashStore, writer, editor } = opts
  const absPath = assertWithinRoot(rootPath, relPath)

  const diskMarkdown = await readDiskMd(absPath)
  const doMarkdown = await yDocToMarkdown(ydoc, editor)
  const doIsEmpty = doMarkdown.trim() === ''
  const doHash = await hashOfNormalisedMarkdown(doMarkdown)

  // ---- No disk file ----
  if (diskMarkdown === null) {
    if (doIsEmpty) {
      // Nothing on either side — drop any stale hash entry and bail.
      await hashStore.delete(relPath)
      return {
        case: 'no-disk-do-empty',
        diskHash: null,
        doHash,
        action: 'no disk file and DO empty; cleared hash entry',
      }
    }
    // Browser-ahead-of-disk: write the DO's content as a new file.
    await writer.write(relPath, doMarkdown)
    const finalHash = await hashOfNormalisedMarkdown(doMarkdown)
    await hashStore.set(relPath, finalHash)
    return {
      case: 'no-disk-do-content',
      diskHash: null,
      doHash,
      action: 'no disk file; wrote DO content to disk',
    }
  }

  // ---- Disk file exists ----
  const diskHash = await hashOfNormalisedMarkdown(diskMarkdown)
  const lastCommittedHash = hashStore.get(relPath)

  if (diskHash === lastCommittedHash) {
    // Case A — DO is authoritative.
    await writer.write(relPath, doMarkdown)
    const finalHash = await hashOfNormalisedMarkdown(doMarkdown)
    await hashStore.set(relPath, finalHash)
    return {
      case: 'A',
      diskHash,
      doHash,
      action: 'disk in sync with last commit; wrote DO content to disk',
    }
  }

  if (doIsEmpty) {
    // Case B — disk is the seed for an empty DO. The caller forwards the
    // resulting Yjs updates to the DO over the DialBackDocClient.
    await markdownToYDoc(diskMarkdown, ydoc)
    const mergedMarkdown = await yDocToMarkdown(ydoc, editor)
    const finalHash = await hashOfNormalisedMarkdown(mergedMarkdown)
    await hashStore.set(relPath, finalHash)
    return {
      case: 'B',
      diskHash,
      doHash,
      action: 'DO empty; seeded Y.Doc from disk',
    }
  }

  // Case C — both sides diverged. CRDT-merge by applying disk-side markdown
  // as a fresh update on top of the existing Y.Doc. Re-serialise back to
  // disk so disk == post-merge Y.Doc. The caller forwards the resulting
  // Yjs updates to the DO over the DialBackDocClient.
  console.warn(
    `[reconcile] merge: ${relPath} diskHash=${diskHash} doHash=${doHash} — applying disk as Y.Doc update on top of DO state`,
  )
  await markdownToYDoc(diskMarkdown, ydoc)
  const mergedMarkdown = await yDocToMarkdown(ydoc, editor)
  await writer.write(relPath, mergedMarkdown)
  const finalHash = await hashOfNormalisedMarkdown(mergedMarkdown)
  await hashStore.set(relPath, finalHash)
  return {
    case: 'C',
    diskHash,
    doHash,
    action: 'both diverged; merged disk into Y.Doc and wrote merged result to disk',
  }
}
