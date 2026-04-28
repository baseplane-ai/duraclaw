import { link, rename, unlink, writeFile } from 'node:fs/promises'

/**
 * Overwrite a file atomically via write-then-rename.
 * Safe for files that are expected to be replaced (e.g. meta snapshots).
 * Uses a `.tmp` sibling and `fs.rename` (which is atomic within a filesystem).
 */
export async function atomicOverwrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, data)
  try {
    await rename(tmp, path)
  } catch (err) {
    // Best-effort cleanup of the tmp file if rename failed
    try {
      await unlink(tmp)
    } catch {
      /* swallow */
    }
    throw err
  }
}

/**
 * Write a file exactly once — the first writer wins.
 * Uses `writeFile` to a `.tmp` then `fs.link(tmp, final)` which atomically
 * fails with `EEXIST` if `final` already exists. The tmp file is always
 * unlinked in the finally block so we don't leave stragglers.
 *
 * Returns `'written'` on success or `'already_exists'` if the final path
 * already existed — callers can log and continue.
 */
export async function atomicWriteOnce(
  path: string,
  data: string,
): Promise<'written' | 'already_exists'> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, data)
  try {
    await link(tmp, path)
    return 'written'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      return 'already_exists'
    }
    throw err
  } finally {
    try {
      await unlink(tmp)
    } catch {
      /* tmp already gone — swallow */
    }
  }
}
