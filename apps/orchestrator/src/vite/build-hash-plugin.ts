/**
 * Vite plugin that generates a `build-hash.json` in the client output directory.
 *
 * The file contains a unique hash that changes on every build, allowing the
 * client to poll for staleness independently of the SW update cycle.
 *
 * The file is tiny (~60 bytes) and served with no-cache headers so polling
 * it every 30s is negligible overhead.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

export function buildHashPlugin(): Plugin {
  let outDir: string
  let hash: string

  return {
    name: 'duraclaw:build-hash',
    apply: 'build',

    configResolved(config) {
      outDir = config.build.outDir
      hash = crypto.randomBytes(8).toString('hex')
    },

    // Write build-hash.json after the bundle is written
    writeBundle() {
      // For CF Workers + @cloudflare/vite-plugin, client assets go to dist/client
      const clientDir = path.resolve(outDir, '../client')
      const targetDir = fs.existsSync(clientDir) ? clientDir : outDir

      fs.writeFileSync(
        path.join(targetDir, 'build-hash.json'),
        JSON.stringify({ hash, ts: Date.now() }),
      )
    },
  }
}
