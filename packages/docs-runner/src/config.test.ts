import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configPath, DEFAULT_CONFIG, DEFAULT_CONFIG_YAML, loadConfig } from './config.js'

describe('configPath', () => {
  it('returns `${dir}/duraclaw-docs.yaml`', () => {
    expect(configPath('/x/y')).toBe('/x/y/duraclaw-docs.yaml')
  })
})

describe('loadConfig', () => {
  let dir: string
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'duraclaw-docs-config-'))
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    warnSpy.mockRestore()
  })

  it('returns DEFAULT_CONFIG and warns when the file is missing', async () => {
    const result = await loadConfig(dir)
    expect(result.source).toBe('default')
    expect(result.config).toEqual(DEFAULT_CONFIG)
    expect(result.path).toBe(join(dir, 'duraclaw-docs.yaml'))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      `[docs-runner] config_missing path=${join(dir, 'duraclaw-docs.yaml')}`,
    )
  })

  it('parses a fully populated yaml file', async () => {
    await writeFile(
      join(dir, 'duraclaw-docs.yaml'),
      `watch:\n  - '*.md'\nexclude:\n  - 'x/**'\ntombstone_grace_days: 14\n`,
    )
    const result = await loadConfig(dir)
    expect(result.source).toBe('file')
    expect(result.config).toEqual({
      watch: ['*.md'],
      exclude: ['x/**'],
      tombstoneGraceDays: 14,
    })
  })

  it('falls back to defaults for fields not present in a partial file', async () => {
    await writeFile(join(dir, 'duraclaw-docs.yaml'), `watch:\n  - 'docs/**/*.md'\n`)
    const result = await loadConfig(dir)
    expect(result.source).toBe('file')
    expect(result.config).toEqual({
      watch: ['docs/**/*.md'],
      exclude: DEFAULT_CONFIG.exclude,
      tombstoneGraceDays: DEFAULT_CONFIG.tombstoneGraceDays,
    })
  })

  it('treats an empty yaml document as all defaults (source: file)', async () => {
    await writeFile(join(dir, 'duraclaw-docs.yaml'), `---\n`)
    const result = await loadConfig(dir)
    expect(result.source).toBe('file')
    expect(result.config).toEqual(DEFAULT_CONFIG)
  })

  it('throws on `watch` that is not an array', async () => {
    await writeFile(join(dir, 'duraclaw-docs.yaml'), `watch: '*.md'\n`)
    await expect(loadConfig(dir)).rejects.toThrow(/invalid/)
  })

  it('throws on negative `tombstone_grace_days`', async () => {
    await writeFile(join(dir, 'duraclaw-docs.yaml'), `tombstone_grace_days: -1\n`)
    await expect(loadConfig(dir)).rejects.toThrow(/invalid/)
  })

  it('throws on non-numeric `tombstone_grace_days`', async () => {
    await writeFile(join(dir, 'duraclaw-docs.yaml'), `tombstone_grace_days: 'seven'\n`)
    await expect(loadConfig(dir)).rejects.toThrow(/invalid/)
  })

  it('round-trips DEFAULT_CONFIG_YAML back into DEFAULT_CONFIG', async () => {
    await writeFile(join(dir, 'duraclaw-docs.yaml'), DEFAULT_CONFIG_YAML)
    const result = await loadConfig(dir)
    expect(result.source).toBe('file')
    expect(result.config).toEqual(DEFAULT_CONFIG)
  })
})
