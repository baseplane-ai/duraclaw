/**
 * GH#92 — unit tests for caam.ts wrapper functions.
 *
 * Uses CAAM_BIN override to point at tiny shell scripts that simulate
 * caam CLI responses, so tests run on dev boxes without the real binary.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  caamActivate,
  caamActiveProfile,
  caamCooldownList,
  caamCooldownSet,
  caamEarliestClearTs,
  caamIsConfigured,
  caamNext,
  caamResolveBin,
  resetCaamConfiguredCache,
} from './caam.js'

describe('caamResolveBin', () => {
  const origBin = process.env.CAAM_BIN

  afterEach(() => {
    if (origBin !== undefined) process.env.CAAM_BIN = origBin
    else delete process.env.CAAM_BIN
  })

  it('returns env override when CAAM_BIN is set', () => {
    process.env.CAAM_BIN = '/custom/path/caam'
    expect(caamResolveBin()).toBe('/custom/path/caam')
  })

  it('returns default path when CAAM_BIN is unset', () => {
    delete process.env.CAAM_BIN
    expect(caamResolveBin()).toBe('/home/ubuntu/bin/caam')
  })
})

describe('caam wrappers with stub binary', () => {
  let dir: string
  let stubBin: string
  const origBin = process.env.CAAM_BIN

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caam-test-'))
    stubBin = join(dir, 'caam-stub')
    process.env.CAAM_BIN = stubBin
    resetCaamConfiguredCache()
  })

  afterEach(async () => {
    if (origBin !== undefined) process.env.CAAM_BIN = origBin
    else delete process.env.CAAM_BIN
    resetCaamConfiguredCache()
    await rm(dir, { recursive: true, force: true })
  })

  /** Write a shell stub that echoes specific output per subcommand. */
  async function writeStub(script: string): Promise<void> {
    await writeFile(stubBin, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  }

  describe('caamIsConfigured', () => {
    it('returns false when binary does not exist', async () => {
      process.env.CAAM_BIN = '/nonexistent/caam-xxx'
      expect(await caamIsConfigured()).toBe(false)
    })

    it('returns false when ls claude exits nonzero', async () => {
      await writeStub('exit 1')
      expect(await caamIsConfigured()).toBe(false)
    })

    it('returns true when ls claude returns profiles', async () => {
      await writeStub('echo "work1"')
      expect(await caamIsConfigured()).toBe(true)
    })

    it('caches result across calls', async () => {
      await writeStub('echo "work1"')
      expect(await caamIsConfigured()).toBe(true)
      // Even if we change the stub to fail, cached result persists
      process.env.CAAM_BIN = '/nonexistent/caam-xxx'
      expect(await caamIsConfigured()).toBe(true)
    })
  })

  describe('caamActiveProfile', () => {
    it('parses profile name from "which" output', async () => {
      await writeStub('echo "claude: work2"')
      expect(await caamActiveProfile()).toBe('work2')
    })

    it('returns null for "(none)" sentinel', async () => {
      await writeStub('echo "claude: (none)"')
      expect(await caamActiveProfile()).toBeNull()
    })

    it('returns null on nonzero exit', async () => {
      await writeStub('exit 1')
      expect(await caamActiveProfile()).toBeNull()
    })
  })

  describe('caamActivate', () => {
    it('succeeds on zero exit code', async () => {
      await writeStub('echo "activated work1"')
      await expect(caamActivate('work1')).resolves.toBeUndefined()
    })

    it('throws on nonzero exit', async () => {
      await writeStub('echo "cooling" >&2; exit 1')
      await expect(caamActivate('work1')).rejects.toThrow(/failed/)
    })

    it('passes --force flag when requested', async () => {
      // Stub that checks for --force in args
      await writeStub(
        'case "$*" in *--force*) echo "force ok";; *) echo "no force" >&2; exit 1;; esac',
      )
      await expect(caamActivate('work1', { force: true })).resolves.toBeUndefined()
      await expect(caamActivate('work1')).rejects.toThrow()
    })
  })

  describe('caamNext', () => {
    it('parses JSON response with activated field', async () => {
      await writeStub('echo \'{"activated":"work3"}\'')
      const result = await caamNext()
      expect(result).toEqual({ activated: 'work3' })
    })

    it('returns null on nonzero exit (all profiles cooling)', async () => {
      await writeStub('exit 1')
      const result = await caamNext()
      expect(result).toBeNull()
    })

    it('falls back to text parse when JSON is invalid', async () => {
      // First call (--json) returns bad JSON, second call (--quiet) returns text
      await writeStub(
        'case "$*" in *--json*) echo "not json";; *--quiet*) echo "activated work4";; *) exit 1;; esac',
      )
      const result = await caamNext()
      expect(result).toEqual({ activated: 'work4' })
    })
  })

  describe('caamCooldownSet', () => {
    it('succeeds on zero exit', async () => {
      await writeStub('echo "cooldown set"')
      await expect(caamCooldownSet('work1', 60)).resolves.toBeUndefined()
    })

    it('throws on nonzero exit', async () => {
      await writeStub('exit 1')
      await expect(caamCooldownSet('work1', 60)).rejects.toThrow(/failed/)
    })
  })

  describe('caamEarliestClearTs', () => {
    it('parses ISO timestamp from cooldown list output', async () => {
      const futureTs = '2099-12-31T23:59:59Z'
      await writeStub(`echo "claude/work1    cooling   clears ${futureTs}"`)
      const result = await caamEarliestClearTs()
      expect(result).toBe(Date.parse(futureTs))
    })

    it('returns now + 60min when no timestamps found', async () => {
      await writeStub('echo "no cooldowns"')
      const before = Date.now()
      const result = await caamEarliestClearTs()
      expect(result).toBeGreaterThanOrEqual(before + 59 * 60_000)
      expect(result).toBeLessThanOrEqual(Date.now() + 61 * 60_000)
    })

    it('returns now + 60min on nonzero exit', async () => {
      await writeStub('exit 1')
      const before = Date.now()
      const result = await caamEarliestClearTs()
      expect(result).toBeGreaterThanOrEqual(before + 59 * 60_000)
    })

    it('picks the earliest when multiple profiles are cooling', async () => {
      const ts1 = '2099-06-15T12:00:00Z'
      const ts2 = '2099-06-15T11:00:00Z' // earlier
      await writeStub(
        `echo "claude/work1    cooling   clears ${ts1}"\necho "claude/work2    cooling   clears ${ts2}"`,
      )
      const result = await caamEarliestClearTs()
      expect(result).toBe(Date.parse(ts2))
    })
  })

  describe('caamCooldownList', () => {
    it('returns raw stdout', async () => {
      await writeStub('echo "claude/work1 cooling"')
      const result = await caamCooldownList()
      expect(result).toContain('claude/work1')
    })
  })
})
