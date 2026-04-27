import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'

/**
 * docs-runner per-worktree configuration.
 *
 * Loaded from `${docsWorktreePath}/duraclaw-docs.yaml` at startup. Fields are
 * merged with `DEFAULT_CONFIG` per-key, so a partial file only overrides what
 * it sets. Yaml uses snake_case (`tombstone_grace_days`); the parsed shape
 * camel-cases to match the rest of the codebase.
 */
export interface DocsRunnerConfig {
  watch: string[]
  exclude: string[]
  tombstoneGraceDays: number
}

export const DEFAULT_CONFIG: DocsRunnerConfig = {
  watch: ['**/*.md'],
  exclude: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
  tombstoneGraceDays: 7,
}

/**
 * Default YAML template that `docs-runner init` writes when the file
 * doesn't exist. Keep this as a string constant so init + parser test
 * round-trip the same content.
 */
export const DEFAULT_CONFIG_YAML: string = `# Duraclaw docs-runner configuration
watch:
  - '**/*.md'
exclude:
  - 'node_modules/**'
  - '.git/**'
  - 'dist/**'
  - 'build/**'
tombstone_grace_days: 7
`

/** Resolve the conventional path of the config file for a docs worktree. */
export function configPath(docsWorktreePath: string): string {
  return join(docsWorktreePath, 'duraclaw-docs.yaml')
}

interface RawConfig {
  watch?: unknown
  exclude?: unknown
  tombstone_grace_days?: unknown
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function validateAndMerge(raw: unknown): DocsRunnerConfig {
  if (raw === null || raw === undefined) {
    // Empty yaml document — all defaults.
    return { ...DEFAULT_CONFIG }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid duraclaw-docs.yaml: top-level value must be a mapping')
  }
  const obj = raw as RawConfig
  const merged: DocsRunnerConfig = { ...DEFAULT_CONFIG }

  if (obj.watch !== undefined) {
    if (!isStringArray(obj.watch)) {
      throw new Error('invalid duraclaw-docs.yaml: `watch` must be an array of strings')
    }
    if (obj.watch.length === 0) {
      throw new Error('invalid duraclaw-docs.yaml: `watch` must be non-empty')
    }
    merged.watch = obj.watch
  }

  if (obj.exclude !== undefined) {
    if (!isStringArray(obj.exclude)) {
      throw new Error('invalid duraclaw-docs.yaml: `exclude` must be an array of strings')
    }
    merged.exclude = obj.exclude
  }

  if (obj.tombstone_grace_days !== undefined) {
    const v = obj.tombstone_grace_days
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(
        'invalid duraclaw-docs.yaml: `tombstone_grace_days` must be a positive finite number',
      )
    }
    merged.tombstoneGraceDays = v
  }

  return merged
}

/**
 * Load config from `${docsWorktreePath}/duraclaw-docs.yaml`. Missing
 * file → returns DEFAULT_CONFIG and logs a single `[docs-runner]
 * config_missing path=...` WARN line via console.warn (B14 / spec
 * line 506). Malformed YAML → throws an Error with a helpful message
 * (caller decides whether to fail or fall back to defaults).
 */
export async function loadConfig(docsWorktreePath: string): Promise<{
  config: DocsRunnerConfig
  source: 'file' | 'default'
  path: string
}> {
  const path = configPath(docsWorktreePath)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      console.warn(`[docs-runner] config_missing path=${path}`)
      return { config: { ...DEFAULT_CONFIG }, source: 'default', path }
    }
    throw err
  }

  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`invalid duraclaw-docs.yaml: ${msg}`)
  }

  const config = validateAndMerge(parsed)
  return { config, source: 'file', path }
}
