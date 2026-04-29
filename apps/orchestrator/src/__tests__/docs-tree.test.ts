/**
 * Docs hierarchy integrity tests (spec GH#135).
 *
 * Codifies the spec's V1-V10 shell-command acceptance criteria into
 * vitest assertions so the docs tree can't quietly drift. The spec
 * lives at planning/specs/135-baseplane-style-docs-hierarchy.md; this
 * file is its in-CI mirror.
 *
 * If a check fails:
 *   - tree shape: someone added/removed a top-level docs/ subdirectory
 *   - theory firewall: a file path leaked into docs/theory/
 *   - rule stub size: someone re-expanded the rule stubs
 *   - CLAUDE.md band: someone bloated or under-trimmed the digest
 *   - cross-link sanity: a `docs/.../X.md` reference points at a missing file
 */

import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// Walk up to the workspace root (where the docs/ tree lives).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8')
}

function exists(rel: string): boolean {
  return existsSync(path.join(REPO_ROOT, rel))
}

function lineCount(rel: string): number {
  return read(rel).split('\n').length - 1 // trailing newline doesn't count
}

function listMd(rel: string): string[] {
  const dir = path.join(REPO_ROOT, rel)
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.posix.join(rel, f))
    .sort()
}

function findDirs(rel: string): string[] {
  const out: string[] = [rel]
  const root = path.join(REPO_ROOT, rel)
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry)
    if (statSync(full).isDirectory()) out.push(...findDirs(path.posix.join(rel, entry)))
  }
  return out.sort()
}

describe('docs/ hierarchy (spec GH#135)', () => {
  describe('V1 — P0 skeleton', () => {
    it('has the expected directory tree', () => {
      const dirs = findDirs('docs')
      expect(dirs).toEqual([
        'docs',
        'docs/_archive',
        'docs/integrations',
        'docs/modules',
        'docs/primitives',
        'docs/primitives/arch',
        'docs/primitives/ui',
        'docs/testing',
        'docs/theory',
      ])
    })

    it('has at least 8 index.md files across the tree', () => {
      const indexes = findDirs('docs')
        .map((d) => path.posix.join(d, 'index.md'))
        .filter((p) => exists(p))
      expect(indexes.length).toBeGreaterThanOrEqual(8)
    })

    it('docs/index.md carries the required substrings', () => {
      const body = read('docs/index.md')
      expect(body).toContain('Survives')
      expect(body).toContain('packages/docs-runner')
      // 6-row hierarchy table — same pattern V1 verifies via grep -cE
      const rows = body.match(/^\| \*\*(Theory|Primitives|Modules|Integrations|Specs|Rules)\*\*/gm)
      expect(rows?.length).toBe(6)
    })

    it('docs/theory/index.md states the canonical discipline sentence verbatim', () => {
      // Grepped by V1 as a fixed-string match. Must remain byte-identical.
      const canonical =
        "New theory content must fit one of these categories — if it doesn't, the categories need revision, not a new file."
      expect(read('docs/theory/index.md')).toContain(canonical)
    })

    it('docs/primitives/index.md carries the layer-test phrase', () => {
      expect(read('docs/primitives/index.md')).toContain('survives a stack rewrite')
    })

    it('docs/_archive/index.md states the dropzone convention', () => {
      expect(read('docs/_archive/index.md')).toContain('dropzone')
    })
  })

  describe('V2 — theory layer firewall', () => {
    const THEORY_FILES = ['domains', 'data', 'dynamics', 'topology', 'trust', 'boundaries']

    it('has exactly 7 markdown files (6 categorical + index)', () => {
      expect(listMd('docs/theory').length).toBe(7)
    })

    for (const f of THEORY_FILES) {
      it(`docs/theory/${f}.md is non-empty`, () => {
        const body = read(`docs/theory/${f}.md`)
        expect(body.trim().length).toBeGreaterThan(0)
      })
    }

    it('contains zero implementation references (no internal file paths or class-name suffixes)', () => {
      // Same regex V2 runs: matches packages/, apps/, src/, .ts: or .tsx:
      const firewall = /(packages\/|apps\/|src\/|\.ts:|\.tsx:)/
      const offenders: string[] = []
      for (const f of THEORY_FILES) {
        const body = read(`docs/theory/${f}.md`)
        body.split('\n').forEach((line, i) => {
          if (firewall.test(line)) offenders.push(`docs/theory/${f}.md:${i + 1}: ${line.trim()}`)
        })
      }
      expect(offenders).toEqual([])
    })

    it('docs/theory/data.md preserves the DO-authoritative substring', () => {
      expect(read('docs/theory/data.md')).toContain('DO-authoritative')
    })
  })

  describe('V3 — atomic rules→theory split', () => {
    it.each([
      ['.claude/rules/session-lifecycle.md', 'docs/theory/dynamics.md'],
      ['.claude/rules/client-data-flow.md', 'docs/theory/data.md'],
    ])('%s is a thin stub linking to %s', (rule, theory) => {
      const body = read(rule)
      expect(lineCount(rule)).toBeLessThan(15)
      expect(body.split('\n')[0]).toBe('---') // frontmatter on line 1
      expect(body).toContain('paths:')
      expect(body).toContain(theory)
    })
  })

  describe('V4 — modules layer', () => {
    const MODULES = [
      'orchestrator',
      'agent-gateway',
      'session-runner',
      'docs-runner',
      'shared-transport',
      'kata',
      'mobile',
    ]

    for (const m of MODULES) {
      it(`docs/modules/${m}.md exists and has the Module Test section`, () => {
        const body = read(`docs/modules/${m}.md`)
        expect(body.trim().length).toBeGreaterThan(0)
        expect(body).toContain('Module Test')
      })

      it(`docs/modules/${m}.md cross-links to theory or integrations (V10 partial)`, () => {
        const body = read(`docs/modules/${m}.md`)
        expect(body).toMatch(/docs\/(theory|integrations)\//)
      })
    }

    it('INVENTORY.md is a tight table with the Domain Question column', () => {
      const body = read('docs/modules/INVENTORY.md')
      expect(body).toContain('Domain Question')
      expect(lineCount('docs/modules/INVENTORY.md')).toBeLessThanOrEqual(30)
    })
  })

  describe('V5 — integrations + testing', () => {
    const INTEGRATIONS = ['cloudflare', 'claude-agent-sdk', 'better-auth', 'capacitor', 'github']

    it('has 6 integration files (5 + index)', () => {
      expect(listMd('docs/integrations').length).toBe(6)
    })

    for (const i of INTEGRATIONS) {
      it(`docs/integrations/${i}.md has Assumptions + What-would-break sections`, () => {
        const body = read(`docs/integrations/${i}.md`)
        expect(body).toContain('## Assumptions')
        expect(body).toContain('## What would break if')
      })
    }

    it('has 3 testing files (2 + index)', () => {
      expect(listMd('docs/testing').length).toBe(3)
    })

    it('prod-test-users.md mentions BOOTSTRAP_TOKEN', () => {
      expect(read('docs/testing/prod-test-users.md')).toContain('BOOTSTRAP_TOKEN')
    })

    it('dev-up.md walks through dev-up.sh', () => {
      expect(read('docs/testing/dev-up.md')).toContain('dev-up.sh')
    })
  })

  describe('V6 — primitives layer', () => {
    it('has at least 4 UI primitive files', () => {
      expect(listMd('docs/primitives/ui').length).toBeGreaterThanOrEqual(4)
    })

    it('has at least 4 arch primitive files', () => {
      expect(listMd('docs/primitives/arch').length).toBeGreaterThanOrEqual(4)
    })

    it('contains zero React/JSX import lines anywhere under primitives', () => {
      // Same regex V6 runs: matches `^import ` or `from "@`.
      const importLine = /^import |from "@/
      const offenders: string[] = []
      for (const sub of ['ui', 'arch']) {
        for (const f of listMd(`docs/primitives/${sub}`)) {
          const body = read(f)
          body.split('\n').forEach((line, i) => {
            if (importLine.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
          })
        }
      }
      expect(offenders).toEqual([])
    })

    it('design-system.md and ai-elements.md are non-empty', () => {
      expect(read('docs/primitives/ui/design-system.md').trim().length).toBeGreaterThan(0)
      expect(read('docs/primitives/ui/ai-elements.md').trim().length).toBeGreaterThan(0)
    })

    it('buffered-channel.md and dial-back-client.md are non-empty', () => {
      expect(read('docs/primitives/arch/buffered-channel.md').trim().length).toBeGreaterThan(0)
      expect(read('docs/primitives/arch/dial-back-client.md').trim().length).toBeGreaterThan(0)
    })
  })

  describe('V7 — CLAUDE.md digest', () => {
    it('lives within the [80, 130] line band', () => {
      const lines = lineCount('CLAUDE.md')
      expect(lines).toBeGreaterThanOrEqual(80)
      expect(lines).toBeLessThanOrEqual(130)
    })

    it('keeps the load-bearing headings + a docs/theory/ link', () => {
      const body = read('CLAUDE.md')
      expect(body).toContain('docs/theory/')
      expect(body).toContain('## Architecture')
      expect(body).toContain('## Monorepo Structure')
      expect(body).toContain('## Key Commands')
    })

    it('the long-form Identity Management prose is gone (heading-only OK)', () => {
      const matches = read('CLAUDE.md')
        .split('\n')
        .filter((line) => line.includes('Identity Management'))
      expect(matches.length).toBeLessThanOrEqual(1)
    })
  })

  describe('V8 — kata theory-primitives-review prompt', () => {
    const PROMPT = '.kata/prompts/theory-primitives-review.md'

    it('references docs/theory/ at least 6 times', () => {
      const body = read(PROMPT)
      const count = (body.match(/docs\/theory\//g) ?? []).length
      expect(count).toBeGreaterThanOrEqual(6)
    })

    it.each([
      'DataForge',
      'CommandBus',
      'EventBus',
    ])('%s appears only in mapping context (→, duraclaw, or "maps to")', (term) => {
      const lines = read(PROMPT).split('\n')
      const offenders = lines.filter(
        (line) => line.includes(term) && !/(→|duraclaw|maps to)/.test(line),
      )
      expect(offenders).toEqual([])
    })

    it('contains no orphan baseplane file references (experience.md / governance.md / verticals/)', () => {
      const body = read(PROMPT)
      expect(body).not.toMatch(/experience\.md|governance\.md|verticals\//)
    })
  })

  describe('V10 — final cross-link sanity', () => {
    it('every docs/X.md reference from in-scope locations resolves', () => {
      // V10 scope per spec: docs/, CLAUDE.md, .claude/rules/, .kata/prompts/.
      // Excludes planning/ — research notes legitimately reference external
      // library docs paths (Zustand's docs/rpc.md, etc.) that we don't host.
      const tracked = execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8' })
        .trim()
        .split('\n')
      const inScope = tracked.filter(
        (f) =>
          f.endsWith('.md') &&
          (f === 'CLAUDE.md' ||
            f.startsWith('docs/') ||
            f.startsWith('.claude/rules/') ||
            f.startsWith('.kata/prompts/')),
      )
      const linkPattern = /docs\/[a-zA-Z_-]+(?:\/[a-zA-Z_-]+)?\.md/g
      const broken = new Set<string>()
      for (const f of inScope) {
        const body = readFileSync(path.join(REPO_ROOT, f), 'utf8')
        const matches = body.match(linkPattern) ?? []
        for (const link of matches) {
          if (!exists(link)) broken.add(`${f} → ${link}`)
        }
      }
      expect([...broken]).toEqual([])
    })
  })
})
