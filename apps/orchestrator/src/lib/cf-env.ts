import type { Env } from './types'

let _env: Env | null = null

export function setCloudflareEnv(env: Env): void {
  _env = env
}

export function getCloudflareEnv(): Env {
  if (!_env) {
    // Try cloudflare:workers module (works in CF Vite plugin dev mode)
    throw new Error('Cloudflare env not set — call setCloudflareEnv() first')
  }
  return _env
}
