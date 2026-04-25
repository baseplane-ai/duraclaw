import { spawnSync } from 'node:child_process'

export interface CaamProfile {
  name: string
  active: boolean
  system: boolean
  [key: string]: unknown
}

const TIMEOUT_MS = 5000

function caamBin(): string {
  return process.env.CAAM_BIN || 'caam'
}

function runCaam(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const res = spawnSync(caamBin(), args, {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
    })
    if (res.error) {
      return { ok: false, stdout: '', stderr: String(res.error) }
    }
    return {
      ok: res.status === 0,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    }
  } catch (err) {
    return { ok: false, stdout: '', stderr: String(err) }
  }
}

/** Run `caam ls claude --json` -> parse -> return profiles[]. Returns [] on
 *  any error (binary missing, exit nonzero, JSON parse fail). */
export function caamLs(): CaamProfile[] {
  const res = runCaam(['ls', 'claude', '--json'])
  if (!res.ok) {
    if (res.stderr) console.error('[caam] ls failed:', res.stderr)
    return []
  }
  try {
    const parsed = JSON.parse(res.stdout)
    if (Array.isArray(parsed)) return parsed as CaamProfile[]
    if (parsed && Array.isArray(parsed.profiles)) return parsed.profiles as CaamProfile[]
    return []
  } catch (err) {
    console.error('[caam] ls JSON parse failed:', err)
    return []
  }
}

/** Run `caam cooldown list --json` -> return Set<string> of profile names
 *  currently in cooldown for the `claude` provider. */
export function caamCooldownList(): Set<string> {
  const res = runCaam(['cooldown', 'list', '--json'])
  if (!res.ok) {
    if (res.stderr) console.error('[caam] cooldown list failed:', res.stderr)
    return new Set()
  }
  try {
    const parsed = JSON.parse(res.stdout)
    const items: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.profiles)
        ? parsed.profiles
        : Array.isArray(parsed?.cooldowns)
          ? parsed.cooldowns
          : []
    const names = new Set<string>()
    for (const item of items) {
      if (typeof item === 'string') {
        names.add(item)
      } else if (
        item &&
        typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string'
      ) {
        names.add((item as { name: string }).name)
      }
    }
    return names
  } catch (err) {
    console.error('[caam] cooldown list JSON parse failed:', err)
    return new Set()
  }
}

/** Run `caam cooldown set claude/<name> --minutes N` where
 *  N = max(1, ceil((untilUnixSec - nowSec) / 60)). */
export function caamCooldownSet(name: string, untilUnixSec: number): boolean {
  const nowSec = Math.floor(Date.now() / 1000)
  const minutes = Math.max(1, Math.ceil((untilUnixSec - nowSec) / 60))
  const res = runCaam(['cooldown', 'set', `claude/${name}`, '--minutes', String(minutes)])
  if (!res.ok && res.stderr) console.error('[caam] cooldown set failed:', res.stderr)
  return res.ok
}

/** Run `caam activate claude <name>`. */
export function caamActivate(name: string): boolean {
  const res = runCaam(['activate', 'claude', name])
  if (!res.ok && res.stderr) console.error('[caam] activate failed:', res.stderr)
  return res.ok
}
