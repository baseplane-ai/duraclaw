#!/usr/bin/env node
/**
 * CDP tap for VP1: connect to Chrome A's page target, enable Network domain,
 * subscribe to webSocketFrameReceived/Sent, log every frame with its
 * Network.WebSocket requestId + url + timestamp + payload.
 *
 * Usage:
 *   node scripts/verify/ws-tap.mjs <chrome-cdp-port> <out-ndjson-path>
 *
 * Exits on SIGINT.
 */
import WebSocket from '/data/projects/duraclaw-dev3/node_modules/.pnpm/ws@8.18.0/node_modules/ws/wrapper.mjs'
import fs from 'node:fs'

const cdpPort = Number(process.argv[2] ?? '11537')
const outPath = process.argv[3] ?? '/tmp/ws-tap.ndjson'

const fetchJson = async (url) => {
  const res = await fetch(url)
  return res.json()
}

const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`)
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('no page target')
  process.exit(2)
}
console.error(`[ws-tap] attaching to ${page.id} ${page.url}`)

const out = fs.createWriteStream(outPath, { flags: 'a' })
const write = (obj) => out.write(JSON.stringify(obj) + '\n')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const inflight = new Map()
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    inflight.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

// Map of Network.requestId -> url
const wsRequests = new Map()

ws.on('open', async () => {
  await call('Network.enable')
  await call('Page.enable')
  console.error('[ws-tap] Network enabled')
  write({ _event: 'tap-started', timestamp: Date.now() })
})

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.id && inflight.has(msg.id)) {
    const { resolve, reject } = inflight.get(msg.id)
    inflight.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Network.webSocketCreated') {
    wsRequests.set(msg.params.requestId, msg.params.url)
    write({ _event: 'ws-created', ...msg.params })
    return
  }
  if (msg.method === 'Network.webSocketFrameReceived') {
    const { requestId, timestamp, response } = msg.params
    const url = wsRequests.get(requestId)
    let parsed
    try { parsed = JSON.parse(response.payloadData) } catch { parsed = { _raw: response.payloadData?.slice(0, 300) } }
    write({ _event: 'recv', requestId, url, timestamp, frame: parsed })
    return
  }
  if (msg.method === 'Network.webSocketFrameSent') {
    const { requestId, timestamp, response } = msg.params
    const url = wsRequests.get(requestId)
    let parsed
    try { parsed = JSON.parse(response.payloadData) } catch { parsed = { _raw: response.payloadData?.slice(0, 300) } }
    write({ _event: 'sent', requestId, url, timestamp, frame: parsed })
    return
  }
  if (msg.method === 'Network.webSocketClosed') {
    write({ _event: 'ws-closed', ...msg.params })
    return
  }
})

ws.on('close', () => {
  console.error('[ws-tap] cdp closed')
  out.end()
})

process.on('SIGINT', () => {
  write({ _event: 'tap-stopped', timestamp: Date.now() })
  ws.close()
  out.end(() => process.exit(0))
})
