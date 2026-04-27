#!/usr/bin/env bun
//
// packages/docs-runner/scripts/vp-yjs-client.mjs
// (symlinked from scripts/verify/gh27-vp-yjs-client.mjs)
//
// Minimal Yjs peer used by the GH#27 verification scripts as a "browser-side"
// client. Connects to a RepoDocumentDO with the runner bearer (so we don't
// need a Better Auth session), executes one of a small set of operations,
// then exits.
//
// Lives inside packages/docs-runner so Bun resolves yjs / y-protocols / ws
// against this package's node_modules. Imports the canonical
// blocknote-bridge so doc state we mutate stays in the same shape the
// runner reads.
//
// Usage:  bun scripts/vp-yjs-client.mjs <op> [args...]
//
// ENV (required):
//   ORCH_URL              ws://127.0.0.1:43054
//   PROJECT_ID            gh27-vp-...
//   REL_PATH              e.g. note.md
//   DOCS_RUNNER_SECRET    bearer
//
// Operations:
//   read                  Connect, sync, dump markdown serialisation, exit.
//   info                  {fragmentBlocks, metaKeys}, exit.
//   wait-text NEEDLE [s]  Connect, sync, observe until NEEDLE appears in
//                         markdown serialisation; exit 0. (Default 30s.)
//   write-line TEXT       Connect, sync, append a markdown paragraph
//                         containing TEXT via blocknote-bridge, broadcast
//                         the resulting Yjs update, brief flush, exit.
//   hold SECS             Connect, hold the WS open SECS seconds.

import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { WebSocket } from 'ws'
import { markdownToYDoc, yDocToMarkdown } from '../dist/index.js'

const MSG_SYNC = 0
const MSG_AWARENESS = 1
const FRAGMENT_NAME = 'document-store'
const META_MAP_NAME = 'meta'

function log(...a) { console.error('[yjs-client]', ...a) }
function fail(msg) { console.error('[yjs-client][FAIL]', msg); process.exit(1) }

function deriveEntityId(projectId, relPath) {
  return createHash('sha256').update(`${projectId}:${relPath}`).digest('hex').slice(0, 16)
}

async function connect() {
  const orch = process.env.ORCH_URL || 'ws://127.0.0.1:43054'
  const projectId = process.env.PROJECT_ID || fail('PROJECT_ID env required')
  const relPath = process.env.REL_PATH || fail('REL_PATH env required')
  const bearer = process.env.DOCS_RUNNER_SECRET || fail('DOCS_RUNNER_SECRET env required')
  const entityId = deriveEntityId(projectId, relPath)
  const url = `${orch}/api/collab/repo-document/${entityId}/ws?role=docs-runner&token=${encodeURIComponent(bearer)}`
  log('connecting', { entityId, url })

  const ydoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(ydoc)
  const ws = new WebSocket(url, { perMessageDeflate: false })
  ws.binaryType = 'arraybuffer'

  let resolveSynced
  const synced = new Promise((r) => { resolveSynced = r })

  ws.on('open', () => {
    log('open — sending sync step 1')
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeSyncStep1(enc, ydoc)
    ws.send(encoding.toUint8Array(enc))
  })

  ws.on('message', (data) => {
    const u8 = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
    const dec = decoding.createDecoder(u8)
    const messageType = decoding.readVarUint(dec)
    if (messageType === MSG_SYNC) {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      const replyType = syncProtocol.readSyncMessage(dec, enc, ydoc, ws)
      if (encoding.length(enc) > 1) {
        ws.send(encoding.toUint8Array(enc))
      }
      if (replyType === syncProtocol.messageYjsSyncStep2) {
        log('synced')
        resolveSynced()
      }
    } else if (messageType === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws)
    }
  })

  ws.on('close', (code, reason) => { log('close', { code, reason: reason?.toString?.() }) })
  ws.on('error', (err) => { log('error', { message: err.message }) })

  await synced
  return { ws, ydoc, awareness }
}

function broadcastUpdate(ws, update) {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_SYNC)
  syncProtocol.writeUpdate(enc, update)
  ws.send(encoding.toUint8Array(enc))
}

async function currentMarkdown(ydoc) {
  return await yDocToMarkdown(ydoc)
}

async function main() {
  const [op, ...rest] = process.argv.slice(2)
  if (!op) fail('missing op argument')

  if (op === 'read') {
    const { ws, ydoc } = await connect()
    process.stdout.write((await currentMarkdown(ydoc)) + '\n')
    ws.close()
    process.exit(0)
  }

  if (op === 'info') {
    const { ws, ydoc } = await connect()
    const fragLen = ydoc.getXmlFragment(FRAGMENT_NAME).length
    const meta = ydoc.getMap(META_MAP_NAME)
    process.stdout.write(JSON.stringify({ fragmentBlocks: fragLen, metaKeys: [...meta.keys()] }) + '\n')
    ws.close()
    process.exit(0)
  }

  if (op === 'write-line') {
    const text = rest[0]
    if (!text) fail('write-line: missing text')
    const { ws, ydoc } = await connect()

    let pending = null
    const collect = (update, origin) => {
      // ignore remote (origin === ws) updates, only forward our own
      if (origin !== ws) {
        pending = pending ? Y.mergeUpdates([pending, update]) : update
      }
    }
    ydoc.on('update', collect)

    const before = await currentMarkdown(ydoc)
    const sep = before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n')
    const after = before + sep + text + '\n'
    await markdownToYDoc(after, ydoc)

    ydoc.off('update', collect)
    if (!pending) fail('no update produced (markdown unchanged?)')
    broadcastUpdate(ws, pending)
    log('write-line sent', { len: pending.length })

    await new Promise((r) => setTimeout(r, 800))
    ws.close()
    process.exit(0)
  }

  if (op === 'wait-text') {
    const needle = rest[0]
    if (!needle) fail('wait-text: missing substring')
    const timeoutS = Number.parseInt(rest[1] ?? '30', 10)
    const { ws, ydoc } = await connect()
    const start = Date.now()
    while (Date.now() - start < timeoutS * 1000) {
      const md = await currentMarkdown(ydoc)
      if (md.includes(needle)) {
        log('wait-text matched', { needle, ms: Date.now() - start })
        ws.close()
        process.exit(0)
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    ws.close()
    fail(`wait-text timeout: needle "${needle}" not seen in ${timeoutS}s`)
  }

  if (op === 'hold') {
    const seconds = Number.parseInt(rest[0] ?? '10', 10)
    const { ws } = await connect()
    log('holding', { seconds })
    await new Promise((r) => setTimeout(r, seconds * 1000))
    ws.close()
    process.exit(0)
  }

  fail(`unknown op: ${op}`)
}

main().catch((err) => {
  console.error('[yjs-client] uncaught', err?.stack || err?.message || String(err))
  process.exit(1)
})
