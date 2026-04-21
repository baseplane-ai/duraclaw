import { readFile } from 'node:fs/promises'

const DEFAULT_DEPLOY_STATE_PATH = '/data/projects/baseplane-infra/.deploy-state.json'

export async function handleDeployState(): Promise<Response> {
  const path = process.env.DEPLOY_STATE_PATH ?? DEFAULT_DEPLOY_STATE_PATH
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
