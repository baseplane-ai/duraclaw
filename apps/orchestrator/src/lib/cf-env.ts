import type { Env } from './types'

let _env: Env | null = null

/**
 * Set the Cloudflare Worker environment bindings.
 * Called from the server entry wrapper before each request.
 */
export function setCloudflareEnv(env: Env): void {
  _env = env
}

/**
 * Get Cloudflare Worker environment bindings in server context.
 * Must be called after setCloudflareEnv() in the same request.
 */
export function getCloudflareEnv(): Env {
  if (!_env) {
    throw new Error('Cloudflare env not set — call setCloudflareEnv() first in this request')
  }
  return _env
}
