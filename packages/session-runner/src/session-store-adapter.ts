/**
 * GH#119 P1.2: DuraclavSessionStore — runner-side `SessionStore` adapter
 * that delegates every transcript op to the SessionDO via
 * `WsTranscriptRpc` over the dial-back WS.
 *
 * The SDK calls into this adapter from inside the subprocess parent:
 * `append()` mirrors each batch of JSONL transcript entries after the
 * local-disk write succeeds; `load()` runs once on resume to materialise
 * the transcript into a temp JSONL file before the subprocess spawns;
 * `listSubkeys()` enumerates subagent transcript subpaths during resume.
 *
 * **Project-key encoding** — the SDK owns `projectKey` encoding (replace
 * `/` with `-`, prepend `-`, djb2-hash if length > 200). The adapter is
 * a pass-through for whatever the SDK provides on `key.projectKey`; we
 * never compute or rewrite the encoding.
 *
 * **Optional methods** — the SDK marks `delete`, `listSessions`, and
 * `listSessionSummaries` as optional. We implement `delete` for parity
 * (harmless and keeps the wire surface symmetric), but skip
 * `listSessions` / `listSessionSummaries` — they're only invoked through
 * `listSessions({sessionStore})`, which we don't expose to consumers
 * today.
 */

import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import type { TranscriptRpc } from './transcript-rpc.js'

export class DuraclavSessionStore implements SessionStore {
  constructor(private readonly rpc: TranscriptRpc) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    await this.rpc.call('appendTranscript', { key, entries })
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.rpc.call<SessionStoreEntry[] | null>('loadTranscript', { key })
  }

  async delete(key: SessionKey): Promise<void> {
    await this.rpc.call('deleteTranscript', { key })
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return this.rpc.call<string[]>('listTranscriptSubkeys', { key })
  }
}
