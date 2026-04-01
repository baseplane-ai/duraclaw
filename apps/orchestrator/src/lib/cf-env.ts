import { env as cfEnv } from 'cloudflare:workers'
import type { Env } from './types'

/**
 * Get Cloudflare Worker environment bindings in server context.
 * Uses the cloudflare:workers module which works in both dev and production.
 */
export function getCloudflareEnv(): Env {
  return cfEnv as unknown as Env
}
