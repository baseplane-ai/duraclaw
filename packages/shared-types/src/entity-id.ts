/**
 * Shared entity-ID derivation (GH#27 B2).
 *
 * Both `projectId` and `entityId` are stable, deterministic 16-char
 * lowercase-hex prefixes of a SHA-256 digest. The browser bundle
 * (P5a DocsEditor), the orchestrator Worker (DO routing), and the
 * docs-runner (Bun runtime) all import this module so the same input
 * produces the same ID in every runtime.
 *
 * Uses `crypto.subtle.digest('SHA-256', …)` — available natively in
 * browsers, Cloudflare Workers, Node 20+, and Bun.
 */

/**
 * Yjs fragment name shared by docs-runner, RepoDocumentDO, and the
 * browser editor. Centralised here so all three runtimes bind their
 * Y.XmlFragment to the same key.
 */
export const DOCS_YDOC_FRAGMENT_NAME = 'document-store' as const

async function sha256Hex16(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0')
  }
  return hex.slice(0, 16)
}

/**
 * Compute the 16-char project ID from a git remote URL.
 * `projectId = sha256(originUrl).slice(0, 16)` (hex, lowercase).
 */
export async function deriveProjectId(originUrl: string): Promise<string> {
  return sha256Hex16(originUrl)
}

/**
 * Compute the 16-char entity ID for a `(projectId, relPath)` pair.
 * `entityId = sha256(projectId + ':' + relPath).slice(0, 16)` (hex).
 */
export async function deriveEntityId(projectId: string, relPath: string): Promise<string> {
  return sha256Hex16(`${projectId}:${relPath}`)
}
