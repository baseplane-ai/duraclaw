/**
 * Minimal HTTP /health server (B14 baseline; P1.8 hardens).
 *
 * Single route — `GET /health` returns `JSON.stringify(snapshot())` with
 * `application/json`. Anything else is a 404. The snapshot function is
 * the caller's job; this module only hosts the listener.
 *
 * Uses `node:http` so the same module works under Bun (which provides a
 * compatible polyfill) and under Node for `tsc --noEmit` and vitest.
 */

import http from 'node:http'

export interface HealthFileEntry {
  path: string
  state: 'syncing' | 'disconnected' | 'tombstoned' | 'error' | 'starting'
  last_sync_ts: number
  error_count: number
}

export interface HealthSnapshot {
  status: 'ok' | 'degraded' | 'down'
  version: string
  uptime_ms: number
  files: number
  syncing: number
  disconnected: number
  tombstoned: number
  errors: number
  reconnects: number
  per_file: HealthFileEntry[]
}

export interface HealthServerOptions {
  port: number
  snapshot: () => HealthSnapshot
}

export class HealthServer {
  private readonly opts: HealthServerOptions
  private server: http.Server | null = null

  constructor(opts: HealthServerOptions) {
    this.opts = opts
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        const body = JSON.stringify(this.opts.snapshot())
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(body)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.opts.port)
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}
