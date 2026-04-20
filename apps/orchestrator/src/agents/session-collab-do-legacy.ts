import { DurableObject } from 'cloudflare:workers'
// Legacy stub — keeps the old non-sqlite SessionCollabDO class alive
// so Cloudflare doesn't error on implicit delete-class. No-op.
export class SessionCollabDO extends DurableObject {
  async fetch() {
    return new Response('gone', { status: 410 })
  }
}
