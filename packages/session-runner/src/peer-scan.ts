/**
 * GH#92 — peer-runner scan. Used by the rate-limit branch in
 * claude-runner.ts (B3 gate 2) to detect a live concurrent Claude
 * session on the same VPS. Because `caam activate` mutates the
 * GLOBAL `~/.claude` directory, rotating while a peer is mid-query
 * would 401 the peer's next API call — so we skip rotation with an
 * `exit_reason:'rate_limited_no_rotate'` breadcrumb instead.
 *
 * Scan is file-system-only: globs sibling `*.meta.json` in
 * `$SESSIONS_DIR` (`/run/duraclaw/sessions` by default), filters to
 * `state:'running'` and `model.startsWith('claude-')`, and skips the
 * caller's own `selfId`. Peers without a meta file, malformed meta,
 * or non-claude models don't count.
 *
 * NOT a liveness check — we don't cross-reference `.pid` liveness.
 * The reaper keeps stale metas cleaned up; a brief race window where
 * a just-exited peer is still "running" in its meta is acceptable
 * (we'd just skip rotation unnecessarily for ~30s, which is safer
 * than the inverse).
 */
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface PeerSummary {
  sessionId: string
  model: string
  lastActivityTs: number | null
}

/**
 * Return live Claude peer runners in `dir`, excluding `selfId`.
 * Silently swallows filesystem / JSON errors — partial results are
 * always safer than a throw for the rotation-skip gate.
 */
export async function scanPeerMeta(dir: string, selfId: string): Promise<PeerSummary[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const out: PeerSummary[] = []
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue
    const sid = basename(f, '.meta.json')
    if (sid === selfId) continue
    let parsed: Record<string, unknown>
    try {
      const raw = await readFile(join(dir, f), 'utf8')
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue
    }
    const state = parsed.state
    const model = parsed.model
    if (state !== 'running') continue
    if (typeof model !== 'string' || !model.startsWith('claude-')) continue
    const lastActivityTs =
      typeof parsed.last_activity_ts === 'number' ? parsed.last_activity_ts : null
    out.push({ sessionId: sid, model, lastActivityTs })
  }
  return out
}
