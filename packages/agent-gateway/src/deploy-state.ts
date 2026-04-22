import { readFile } from 'node:fs/promises'

const DEFAULT_DEPLOY_STATE_PATH = '/data/projects/baseplane-infra/.deploy-state.json'

// Repo name whitelist: lowercase letters, digits, and single hyphens.
// Guards against path traversal when we build the default path from it.
const REPO_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

function resolveStatePath(repo: string | null): string | null {
  // Reject malformed repo names up front to guard against path traversal via
  // the per-repo env-var lookup below.
  if (repo && !REPO_NAME_RE.test(repo)) return null

  // Per-repo override wins when present — lets operators pin a specific state
  // file even when there's no `<repo>-infra` sibling checkout.
  if (repo) {
    const envKey = `DEPLOY_STATE_PATH_${repo.toUpperCase().replace(/-/g, '_')}`
    const envPath = process.env[envKey]
    if (envPath) return envPath
  }

  // Default: one shared baseplane-infra deploy server drives every project
  // (baseplane, duraclaw, …) and writes a single `.deploy-state.json`. There
  // is no `<repo>-infra` sibling convention — infra is centralized.
  return process.env.DEPLOY_STATE_PATH ?? DEFAULT_DEPLOY_STATE_PATH
}

export async function handleDeployState(url?: URL): Promise<Response> {
  const repo = url?.searchParams.get('repo') ?? null
  const path = resolveStatePath(repo)
  if (!path) {
    return new Response(JSON.stringify({ error: 'invalid repo' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const raw = await readFile(path, 'utf-8')
    // Passthrough — client receives the infra-authored JSON verbatim so the
    // wire shape matches `.deploy-state.json` / the deploy server's /status.
    return new Response(raw, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    const status = code === 'ENOENT' ? 404 : 500
    const message = code === 'ENOENT' ? 'deploy state file not found' : 'deploy state read failed'
    return new Response(JSON.stringify({ error: message, path, code }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
